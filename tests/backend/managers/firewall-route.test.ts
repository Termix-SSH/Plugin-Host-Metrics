import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import {
  IPTABLES,
  NFT,
  NFT_INPUT,
  UFW_ACTIVE,
  firewallRead,
  ok,
  type FirewallTools,
} from "../firewall-fixtures.js";

const { execCommand, execElevated } = vi.hoisted(() => ({
  execCommand: vi.fn(),
  execElevated: vi.fn(),
}));
vi.mock("@termix-ssh/plugin-sdk/host-commands", async (original) => ({
  ...(await original<object>()),
  execCommand,
  execElevated,
}));
import { editAccessDenied } from "../../../src/backend/managers/route-helpers.js";
import { registerFirewallRoutes } from "../../../src/backend/managers/firewall.js";

describe("firewall routes with real collector", () => {
  let tools: FirewallTools;
  let persistence: ReturnType<typeof ok>;
  const client = {};
  const ufwProbe = () =>
    ok(
      JSON.stringify({
        rows: [],
        canonical: true,
        config: [],
        rawfiles: [],
        ipv6: true,
      }),
    );
  const host = { sudoPassword: "saved-password" };
  const handlers = new Map<
    string,
    (req: Request, res: Response) => Promise<unknown>
  >();
  const runOnHost = vi.fn(async (_id, _level, fn) => fn(client, host));
  const rule = { op: "add", protocol: "tcp", port: 443, target: "ACCEPT" };

  beforeEach(() => {
    tools = {};
    persistence = ok("netfilter-persistent\n");
    execCommand
      .mockReset()
      .mockImplementation(async (_client, command: string) =>
        command.includes("test -x")
          ? persistence
          : firewallRead(command, tools),
      );
    execElevated
      .mockReset()
      .mockImplementation(async (_client, command: string) =>
        command.includes("/usr/bin/python3")
          ? ufwProbe()
          : command.startsWith("LC_ALL=C")
            ? firewallRead(command, tools)
            : ok("done"),
      );
    runOnHost.mockClear();
    runOnHost.mockImplementation(async (_id, _level, fn) => fn(client, host));
    handlers.clear();
    const register =
      (method: string) =>
      (path: string, ...callbacks: unknown[]) =>
        handlers.set(method + path, callbacks.at(-1) as never);
    registerFirewallRoutes(
      { get: register("GET"), post: register("POST") } as never,
      {
        runOnHost,
        validateHostId: vi.fn(),
        log: { error: vi.fn() },
      } as never,
    );
  });
  async function call(
    action: "read" | "rule" | "persist" | "manage",
    body: unknown = rule,
  ) {
    const status = vi.fn();
    const json = vi.fn();
    const res = { status, json };
    status.mockReturnValue(res);
    const suffix = action === "read" ? "" : "/" + action;
    await handlers.get(
      (action === "read" ? "GET" : "POST") +
        "/host-metrics/managers/firewall/:id" +
        suffix,
    )!({ params: { id: "7" }, body } as Request, res as never);
    return {
      status: status.mock.calls[0]?.[0] ?? 200,
      body: json.mock.calls[0]?.[0],
    };
  }
  const mutations = () =>
    execElevated.mock.calls.filter(
      ([, cmd]) =>
        !cmd.startsWith("LC_ALL=C") && !cmd.includes("/usr/bin/python3"),
    );

  it.each(["read", "rule", "persist"] as const)(
    "passes saved credentials to detection for %s",
    async (action) => {
      tools = { ufw: { stdout: "", stderr: "denied", code: 1 } };
      execElevated.mockImplementation(async (_c, cmd: string) =>
        cmd.includes("/usr/bin/python3")
          ? ufwProbe()
          : cmd.startsWith("LC_ALL=C")
            ? ok(UFW_ACTIVE)
            : ok("done"),
      );
      const result = await call(action);
      expect(result.status).toBe(200);
      expect(execElevated).toHaveBeenCalledWith(
        client,
        "LC_ALL=C /usr/sbin/ufw status verbose",
        host.sudoPassword,
        expect.objectContaining({ forceSudo: true }),
      );
      expect(runOnHost).toHaveBeenCalledWith(
        7,
        action === "read" ? "connect" : "edit",
        expect.any(Function),
      );
      if (action === "rule")
        expect(mutations()[0][1]).toContain("ufw allow 443/tcp");
      else expect(mutations()).toHaveLength(0);
    },
  );
  it("re-detects the owner for each request rather than reusing a GET backend", async () => {
    tools = { "iptables-save": ok(IPTABLES) };
    expect((await call("read")).body.type).toBe("iptables");
    tools.ufw = ok(UFW_ACTIVE);
    expect((await call("rule")).body.backend).toBe("ufw");
    expect(mutations()[0][1]).toContain("ufw allow");
  });
  it.each(["rule", "persist"] as const)(
    "rejects unknown backend before %s mutations",
    async (action) => {
      const result = await call(action);
      expect(result.status).toBe(500);
      expect(result.body.error).toContain("No supported firewall backend");
      expect(execElevated).not.toHaveBeenCalled();
    },
  );
  it.each(["rule", "persist"] as const)(
    "rejects unreadable UFW before %s mutations",
    async (action) => {
      tools = {
        ufw: { stdout: UFW_ACTIVE, stderr: "failure", code: 1 },
        "iptables-save": ok(IPTABLES),
      };
      expect((await call(action)).status).toBe(500);
      expect(mutations()).toHaveLength(0);
    },
  );
  it.each(["rule", "persist"] as const)(
    "blocks running/conflicting firewalld before %s mutations",
    async (action) => {
      tools = {
        "firewall-cmd": ok("running\n"),
        ufw: ok(UFW_ACTIVE),
        nft: ok(NFT),
      };
      expect((await call(action)).body.error).toContain("firewalld is running");
      expect(execElevated).not.toHaveBeenCalled();
    },
  );
  it.each([false, true])(
    "blocks orphaned UFW/firewalld raw policy with UFW inactive=%s",
    async (inactive) => {
      tools = {
        nft: ok(NFT + NFT.replace("inet filter", "inet firewalld")),
        "nft-chain": ok(NFT_INPUT),
      };
      if (inactive) tools.ufw = ok("Status: inactive\n");
      expect((await call("rule")).body.error).toContain("ownership markers");
      expect((await call("persist")).status).toBe(500);
      expect(mutations()).toHaveLength(0);
    },
  );
  it("returns inactive UFW on GET without a raw INPUT chain", async () => {
    tools = { ufw: ok("Status: inactive\n"), "iptables-save": ok(), nft: ok() };
    expect(await call("read")).toMatchObject({
      status: 200,
      body: { type: "ufw", status: "inactive", chains: [] },
    });
    expect(execElevated).not.toHaveBeenCalled();
  });
  it("uses native iptables and the saved password when no manager owns it", async () => {
    tools = { ufw: ok("Status: inactive\n"), "iptables-save": ok(IPTABLES) };
    expect((await call("rule")).body).toMatchObject({
      success: true,
      backend: "iptables",
    });
    expect(mutations()[0]).toEqual([
      client,
      expect.stringContaining("iptables -A INPUT -p tcp --dport 443 -j ACCEPT"),
      host.sudoPassword,
      { forceSudo: true },
    ]);
  });
  it("never creates a missing iptables INPUT chain", async () => {
    tools = { "iptables-save": ok() };
    expect((await call("rule")).body.error).toContain(
      "No supported iptables filter INPUT",
    );
    expect(mutations()).toHaveLength(0);
  });
  it("validates the existing hooked nft chain before a native rule", async () => {
    tools = { nft: ok(NFT), "nft-chain": ok(NFT_INPUT) };
    expect((await call("rule")).body).toMatchObject({
      success: true,
      backend: "nftables",
    });
    expect(mutations()[0][1]).toContain(
      "nft add rule inet filter input tcp dport 443 accept",
    );
    expect(
      execCommand.mock.calls.some(([, cmd]) =>
        cmd.includes("-j list chain inet filter input"),
      ),
    ).toBe(true);
  });
  it("uses saved credentials for both native nft reads and input-chain verification", async () => {
    tools = {
      nft: { stdout: "", stderr: "denied", code: 1 },
      "nft-chain": { stdout: "", stderr: "denied", code: 1 },
    };
    execElevated.mockImplementation(async (_client, command: string) =>
      command.startsWith("LC_ALL=C")
        ? ok(command.includes("-j ") ? NFT_INPUT : NFT)
        : ok("done"),
    );
    expect((await call("rule")).body).toMatchObject({
      success: true,
      backend: "nftables",
    });
    const readCalls = execElevated.mock.calls.filter(([, command]) =>
      command.startsWith("LC_ALL=C"),
    );
    expect(readCalls).toHaveLength(3);
    expect(
      readCalls.every(([, , password]) => password === host.sudoPassword),
    ).toBe(true);
  });
  it.each([
    ok("not JSON"),
    ok(JSON.stringify({ nftables: [] })),
    ok(NFT_INPUT.replace('"hook":"input"', '"hook":"forward"')),
    ok(NFT_INPUT.replace('"type":"filter"', '"type":"nat"')),
    ok(NFT_INPUT.replace('"family":"inet"', '"family":"ip"')),
    { stdout: NFT_INPUT, stderr: "failed", code: 1 },
  ])("rejects missing/incompatible nft topology: %j", async (chain) => {
    tools = { nft: ok(NFT), "nft-chain": chain };
    expect((await call("rule")).status).toBe(500);
    expect(mutations()).toHaveLength(0);
  });
  it("treats UFW persistence as a no-op, without dump/reload", async () => {
    tools = {
      ufw: ok(UFW_ACTIVE),
      "iptables-save": ok(IPTABLES),
      nft: ok(NFT),
    };
    expect((await call("persist")).body).toMatchObject({
      success: true,
      backend: "ufw",
    });
    expect(mutations()).toHaveLength(0);
    expect(execCommand.mock.calls.map(([, cmd]) => cmd).join("\n")).not.toMatch(
      /save|reload|nftables.conf/,
    );
  });
  it.each(["netfilter-persistent", "service"])(
    "persists only via positively detected %s",
    async (mechanism) => {
      tools = { "iptables-save": ok(IPTABLES) };
      persistence = ok(mechanism + "\n");
      expect((await call("persist")).body.success).toBe(true);
      const command = mutations()[0][1];
      expect(command).toContain(
        mechanism === "service"
          ? "service iptables save"
          : "netfilter-persistent save",
      );
      expect(command).not.toMatch(/\|\||nft list|nftables.conf/);
    },
  );
  it("requires both netfilter-persistent plugins when IPv6 chains exist", async () => {
    tools = { "iptables-save": ok(IPTABLES), "ip6tables-save": ok(IPTABLES) };
    expect((await call("persist")).body.success).toBe(true);
    expect(
      execCommand.mock.calls.some(([, command]) =>
        command.includes("25-ip6tables"),
      ),
    ).toBe(true);
    persistence = ok("service\n");
    expect((await call("persist")).body.error).toContain(
      "IPv4/IPv6 persistence",
    );
    expect(mutations()).toHaveLength(1);
  });
  it("keeps native persistence failure a failure, with no fallback", async () => {
    tools = { "iptables-save": ok(IPTABLES) };
    execElevated.mockResolvedValue({
      stdout: "",
      stderr: "save failed",
      code: 1,
    });
    expect((await call("persist")).body).toMatchObject({
      success: false,
      output: "save failed",
    });
    expect(mutations()).toHaveLength(1);
  });
  it("rejects unavailable persistence without executing any save", async () => {
    tools = { "iptables-save": ok(IPTABLES) };
    persistence = { stdout: "", stderr: "", code: 1 };
    expect((await call("persist")).body.error).toContain(
      "No supported iptables persistence mechanism",
    );
    expect(mutations()).toHaveLength(0);
  });
  it("does not overwrite guessed native nft persistence files", async () => {
    tools = { nft: ok(NFT) };
    expect((await call("persist")).body.error).toContain(
      "Native nftables persistence is not supported",
    );
    expect(execElevated).not.toHaveBeenCalled();
  });
  it.each(["rule", "manage", "persist"] as const)(
    "requires edit access for %s before any SSH read/write",
    async (action) => {
      runOnHost.mockRejectedValueOnce(editAccessDenied());
      const result = await call(action, {});
      expect(result.status).toBe(403);
      expect(result.body.code).toBe("HOST_EDIT_REQUIRED");
      expect(runOnHost).toHaveBeenCalledWith(7, "edit", expect.any(Function));
      expect(execCommand).not.toHaveBeenCalled();
      expect(execElevated).not.toHaveBeenCalled();
    },
  );
  it("does not allow legacy delete-by-port to bypass exact identity", async () => {
    expect((await call("rule", { ...rule, op: "delete" })).status).toBe(400);
    expect(execCommand).not.toHaveBeenCalled();
    expect(execElevated).not.toHaveBeenCalled();
  });
  it("rejects stale snapshots for legacy add, management and persistence", async () => {
    tools = { ufw: ok(UFW_ACTIVE) };
    for (const action of ["rule", "manage", "persist"] as const) {
      const body =
        action === "rule"
          ? { ...rule, snapshot: "old" }
          : { op: "policy", id: "INPUT", value: "allow", snapshot: "old" };
      expect((await call(action, body)).status).toBe(400);
    }
    expect(mutations()).toHaveLength(0);
  });
  it("refuses UFW additions if exact parser metadata is unavailable", async () => {
    tools = { ufw: ok(UFW_ACTIVE) };
    execElevated.mockResolvedValue(ok("not JSON"));
    expect((await call("rule")).status).toBe(400);
    expect(mutations()).toHaveLength(0);
  });
  it("retains port validation before detection or mutation", async () => {
    expect(
      (await call("rule", { ...rule, port: "443; echo unsafe" })).status,
    ).toBe(400);
    expect(execCommand).not.toHaveBeenCalled();
    expect(execElevated).not.toHaveBeenCalled();
  });
});
