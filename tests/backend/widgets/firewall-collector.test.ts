import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "ssh2";

const execCommand = vi.fn();
const execElevated = vi.fn();
vi.mock("@termix-ssh/plugin-sdk/host-commands", () => ({
  execCommand: (...args: unknown[]) => execCommand(...args),
  execElevated: (...args: unknown[]) => execElevated(...args),
}));

const { collectFirewallMetrics, parseUfwStatus } =
  await import("../../../src/backend/widgets/firewall-collector.js");

import {
  UFW_ACTIVE as ACTIVE,
  IPTABLES,
  NFT,
  ok,
  firewallRead,
  type FirewallTools,
} from "../firewall-fixtures.js";

describe("parseUfwStatus", () => {
  it("reads an active ufw into input and output chains", () => {
    const result = parseUfwStatus(ACTIVE)!;
    expect(result.type).toBe("ufw");
    expect(result.status).toBe("active");
    const [input, output] = result.chains;
    expect(input.policy).toBe("DENY");
    expect(output.policy).toBe("ALLOW");
    expect(input.rules[0]).toMatchObject({
      target: "ALLOW",
      protocol: "tcp",
      dport: "22",
      source: "0.0.0.0/0",
    });
    expect(input.rules[1]).toMatchObject({
      dport: "80,443",
      source: "192.168.1.0/24",
    });
    expect(input.rules[2]).toMatchObject({ target: "LIMIT", extra: "OpenSSH" });
    expect(input.rules).toHaveLength(4);
    expect(output.rules[0]).toMatchObject({ protocol: "udp", dport: "53" });
  });

  it("displays IPv6 Anywhere as ::/0 rather than the IPv4 catch-all", () => {
    const rules = parseUfwStatus(ACTIVE)!.chains[0].rules;
    expect(rules.at(-1)).toMatchObject({
      source: "::/0",
      destination: "::/0",
      dport: "22",
    });
    expect(rules[0].source).toBe("0.0.0.0/0");
  });

  it("reports an inactive ufw and ignores other output", () => {
    expect(parseUfwStatus("Status: inactive\n")).toEqual({
      type: "ufw",
      status: "inactive",
      chains: [],
    });
    expect(parseUfwStatus("ufw: command not found")).toBeNull();
  });
  it.each(["Status: mystery", "Status: active but failed", "Status:"])(
    "rejects malformed status %s",
    (status) => {
      expect(parseUfwStatus(status)).toBeNull();
    },
  );
});

describe("collectFirewallMetrics", () => {
  const client = {} as Client;
  let tools: FirewallTools;
  beforeEach(() => {
    tools = {};
    execCommand
      .mockReset()
      .mockImplementation(async (_c, command) => firewallRead(command, tools));
    execElevated.mockReset();
  });
  const collect = () => collectFirewallMetrics(client, undefined, true);
  const reads = () =>
    execCommand.mock.calls.map(([, command]) => command as string);

  it("selects active UFW without reading its raw iptables/nft backing rules", async () => {
    tools = { ufw: ok(ACTIVE), "iptables-save": ok(IPTABLES), nft: ok(NFT) };
    expect(await collect()).toMatchObject({ type: "ufw", status: "active" });
    expect(reads().join("\n")).not.toMatch(/command -v (iptables-save|nft)/);
  });

  it.each([false, true])(
    "keeps native iptables when UFW inactive=%s",
    async (inactive) => {
      tools = { "iptables-save": ok(IPTABLES) };
      if (inactive) tools.ufw = ok("Status: inactive\n");
      expect(await collect()).toMatchObject({
        type: "iptables",
        status: "active",
      });
    },
  );
  it.each([false, true])(
    "keeps native nftables when UFW inactive=%s",
    async (inactive) => {
      tools = { nft: ok(NFT) };
      if (inactive) tools.ufw = ok("Status: inactive\n");
      expect(await collect()).toMatchObject({
        type: "nftables",
        status: "active",
      });
    },
  );
  it("shows inactive UFW when native reads are valid empty", async () => {
    tools = { ufw: ok("Status: inactive\n"), "iptables-save": ok(), nft: ok() };
    expect(await collect()).toEqual({
      type: "ufw",
      status: "inactive",
      chains: [],
    });
  });

  it.each([
    { stdout: "", stderr: "Permission denied", code: 1 },
    { stdout: ACTIVE, stderr: "partial failure", code: 1 },
    { stdout: "Status: broken\n", stderr: "", code: 0 },
    { stdout: "", stderr: "", code: null },
    new Error("SSH command timed out"),
  ])(
    "does not fall through unreadable, partial or malformed UFW: %j",
    async (result) => {
      tools = { ufw: result, "iptables-save": ok(IPTABLES), nft: ok(NFT) };
      await expect(collect()).rejects.toThrow();
      expect(reads().join("\n")).not.toMatch(/command -v (iptables-save|nft)/);
      expect(await collectFirewallMetrics(client)).toEqual({
        type: "none",
        status: "unknown",
        chains: [],
      });
      expect(execElevated).not.toHaveBeenCalled();
    },
  );

  it("elevates failed UFW reads with the saved password and absolute path", async () => {
    tools = { ufw: { stdout: "partial", stderr: "denied", code: 1 } };
    execElevated.mockResolvedValue(ok(ACTIVE));
    expect(await collectFirewallMetrics(client, "saved", true)).toMatchObject({
      type: "ufw",
    });
    expect(execElevated).toHaveBeenCalledWith(
      client,
      "LC_ALL=C /usr/sbin/ufw status verbose",
      "saved",
      { forceSudo: true, timeoutMs: 15000 },
    );
    expect(reads().join("\n")).not.toContain("sudo");
  });
  it("rejects failed elevated reads even if stdout looks valid", async () => {
    tools = { ufw: { stdout: "", stderr: "denied", code: 1 } };
    execElevated.mockResolvedValue({
      stdout: ACTIVE,
      stderr: "failure",
      code: 1,
    });
    await expect(collectFirewallMetrics(client, "saved", true)).rejects.toThrow(
      "Cannot read ufw",
    );
  });
  it("does not mistake failed discovery for absence", async () => {
    execCommand.mockResolvedValue({
      stdout: "",
      stderr: "shell failed",
      code: 127,
    });
    await expect(collect()).rejects.toThrow("Cannot locate");
  });

  it.each([
    ok("running\n"),
    ok("unknown\n"),
    { stdout: "failed\n", stderr: "", code: 251 },
    { stdout: "not running\n", stderr: "", code: 1 },
    { stdout: "", stderr: "Access denied", code: 1 },
    new Error("firewalld timeout"),
  ])("blocks firewalld active/unknown/unreadable: %j", async (state) => {
    tools = {
      "firewall-cmd": state,
      ufw: ok(ACTIVE),
      "iptables-save": ok(IPTABLES),
    };
    await expect(collect()).rejects.toThrow();
    expect(reads().join("\n")).not.toContain("command -v ufw");
  });
  it("allows the documented firewalld NOT_RUNNING state", async () => {
    tools = {
      "firewall-cmd": { stdout: "not running\n", stderr: "", code: 252 },
      "iptables-save": ok(IPTABLES),
    };
    expect(await collect()).toMatchObject({ type: "iptables" });
  });

  it.each(["iptables", "nftables"])(
    "recognizes policy-only %s DROP as active",
    async (backend) => {
      tools =
        backend === "iptables"
          ? { "iptables-save": ok(IPTABLES.replace(/^-A.*\n/m, "")) }
          : { nft: ok(NFT.replace(/^\s*tcp dport.*\n/m, "")) };
      expect(await collect()).toMatchObject({
        type: backend,
        status: "active",
      });
      expect((await collect()).chains[0].rules).toHaveLength(0);
    },
  );
  it("allows native nftables alongside an empty default-ACCEPT iptables filter", async () => {
    tools = {
      "iptables-save": ok(
        IPTABLES.replace("INPUT DROP", "INPUT ACCEPT").replace(/^-A.*\n/m, ""),
      ),
      nft: ok(NFT),
    };
    expect(await collect()).toMatchObject({ type: "nftables" });
  });
  it("does not treat NAT rules as INPUT rules", async () => {
    tools = {
      "iptables-save": ok(
        IPTABLES +
          "*nat\n:INPUT ACCEPT [0:0]\n-A INPUT -p tcp --dport 80 -j ACCEPT\nCOMMIT\n",
      ),
    };
    expect(
      (await collect()).chains.find((c) => c.name === "INPUT")?.rules,
    ).toHaveLength(1);
  });
  it("does not erase a filter DROP policy with an empty NAT chain of the same name", async () => {
    tools = {
      "iptables-save": ok(
        IPTABLES.replace(/^-A.*\n/m, "") +
          "*nat\n:INPUT ACCEPT [0:0]\nCOMMIT\n",
      ),
    };
    expect(await collect()).toMatchObject({
      type: "iptables",
      status: "active",
    });
  });
  it("accepts a valid empty iptables-save with only comments", async () => {
    tools = {
      ufw: ok("Status: inactive\n"),
      "iptables-save": ok("# Generated by iptables-save\n# Completed\n"),
    };
    expect(await collect()).toMatchObject({ type: "ufw", status: "inactive" });
  });
  it("accepts unmarked iptables-nft tables that iptables-save also lists", async () => {
    tools = {
      "iptables-save": ok(IPTABLES.replace("(legacy)", "(nf_tables)")),
      nft: ok(NFT.replace("inet filter", "ip filter")),
    };
    expect(await collect()).toMatchObject({ type: "iptables" });
  });
  it("accepts unmarked ip6 tables only when ip6tables-save is nf_tables too", async () => {
    const nf = IPTABLES.replace("(legacy)", "(nf_tables)");
    tools = {
      "iptables-save": ok(nf),
      "ip6tables-save": ok(nf),
      nft: ok(NFT.replace("inet filter", "ip6 filter")),
    };
    expect(await collect()).toMatchObject({ type: "iptables" });
    tools["ip6tables-save"] = ok(IPTABLES);
    await expect(collect()).rejects.toThrow("Mixed or ambiguous");
    delete tools["ip6tables-save"];
    await expect(collect()).rejects.toThrow("Mixed or ambiguous");
  });
  it("treats an active legacy IPv6 firewall beside native nft as ambiguous", async () => {
    const accept = IPTABLES.replace(/^-A .*\n/gm, "").replace(
      "DROP [0:0]",
      "ACCEPT [0:0]",
    );
    tools = {
      "iptables-save": ok(accept),
      "ip6tables-save": ok(IPTABLES),
      nft: ok(NFT),
    };
    await expect(collect()).rejects.toThrow("Mixed or ambiguous");
  });
  it("accepts IPv6-only iptables-nft and rejects ip6tables ownership markers", async () => {
    const nf = IPTABLES.replace("(legacy)", "(nf_tables)");
    tools = {
      "iptables-save": ok(""),
      "ip6tables-save": ok(nf),
      nft: ok(NFT.replace("inet filter", "ip6 filter")),
    };
    expect(await collect()).toMatchObject({
      type: "iptables",
      status: "active",
    });
    tools["ip6tables-save"] = ok(nf.replace("-j ACCEPT", "-j ufw6-user-input"));
    await expect(collect()).rejects.toThrow("ownership markers");
  });
  it("keeps unmarked inet or unlisted nft tables ambiguous", async () => {
    const nf = IPTABLES.replace("(legacy)", "(nf_tables)");
    tools = { "iptables-save": ok(nf), nft: ok(NFT) };
    await expect(collect()).rejects.toThrow("Mixed or ambiguous");
    tools.nft = ok(NFT.replace("inet filter", "ip other"));
    await expect(collect()).rejects.toThrow("Mixed or ambiguous");
  });
  it("rejects genuinely mixed native policies", async () => {
    tools = { "iptables-save": ok(IPTABLES), nft: ok(NFT) };
    await expect(collect()).rejects.toThrow("Mixed or ambiguous");
  });
  it("keeps positively marked iptables-nft compatibility tables on iptables", async () => {
    tools = {
      "iptables-save": ok(IPTABLES.replace("(legacy)", "(nf_tables)")),
      nft: ok(
        NFT.replace("inet filter", "ip filter"),
        "# Warning: table ip filter is managed by iptables-nft, do not touch!\n",
      ),
    };
    expect(await collect()).toMatchObject({ type: "iptables" });
    tools.nft = ok(
      NFT.replace("inet filter", "ip filter") + NFT,
      "# Warning: table ip filter is managed by iptables-nft, do not touch!\n",
    );
    await expect(collect()).rejects.toThrow();
  });
  it.each(["native-policy", '"native policy"'])(
    "does not overlook an additional nft table named %s",
    async (name) => {
      tools = {
        "iptables-save": ok(IPTABLES.replace("(legacy)", "(nf_tables)")),
        nft: ok(
          NFT.replace("inet filter", "ip filter") +
            NFT.replace("inet filter", `inet ${name}`),
          "# Warning: table ip filter is managed by iptables-nft, do not touch!\n",
        ),
      };
      await expect(collect()).rejects.toThrow();
    },
  );
  it.each([false, true])(
    "rejects stale manager-owned raw rules with inactive UFW=%s",
    async (inactive) => {
      tools = {
        "iptables-save": ok(IPTABLES.replace("-j ACCEPT", "-j ufw-user-input")),
      };
      if (inactive) tools.ufw = ok("Status: inactive\n");
      await expect(collect()).rejects.toThrow("ownership markers");
      tools = { nft: ok(NFT + NFT.replace("inet filter", "inet firewalld")) };
      if (inactive) tools.ufw = ok("Status: inactive\n");
      await expect(collect()).rejects.toThrow("ownership markers");
    },
  );
  it.each([
    ok("garbage"),
    ok("*filter\n:INPUT DROP [0:0]\n"),
    ok(IPTABLES, "incompatible, use nft"),
  ])("rejects incomplete/incompatible iptables: %j", async (result) => {
    tools = { "iptables-save": result, nft: ok(NFT) };
    await expect(collect()).rejects.toThrow("Cannot parse complete iptables");
  });
  it.each([ok("garbage"), ok(NFT.slice(0, -3)), ok(NFT, "unexpected warning")])(
    "rejects incomplete/uncertain nft output: %j",
    async (result) => {
      tools = { nft: result };
      await expect(collect()).rejects.toThrow();
    },
  );
  it("distinguishes absent tools from an installed empty nft ruleset", async () => {
    await expect(collect()).rejects.toThrow("No supported firewall backend");
    tools = { nft: ok() };
    expect(await collect()).toEqual({
      type: "nftables",
      status: "inactive",
      chains: [],
    });
  });
});
