import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "ssh2";
import type { ManagedRuleSpec } from "../../../src/shared/firewall-management.js";
const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  collect: vi.fn(),
  exec: vi.fn(),
}));
vi.mock("../../../src/backend/widgets/firewall-collector.js", () => ({
  readFirewall: mocks.read,
  collectFirewallMetrics: mocks.collect,
}));
vi.mock("@termix-ssh/plugin-sdk/host-commands", async (original) => ({
  ...(await original<object>()),
  execElevated: mocks.exec,
}));
import {
  readManagement,
  mutateManaged,
  validateManagedSpec,
  withFirewallLock,
  UFW_PROBE,
} from "../../../src/backend/managers/firewall-management.js";

const client = {} as Client;
const spec: ManagedRuleSpec = {
  family: "ipv4",
  direction: "in",
  action: "allow",
  protocol: "tcp",
  source: "192.0.2.0/24",
  destination: "0.0.0.0/0",
  port: "443",
  sourcePort: "any",
  comment: "keep ' this",
};
const ufwRow = (s = spec, number = 1) => ({
  action: s.action,
  protocol: s.protocol,
  dport: s.port,
  dst: s.destination,
  sport: s.sourcePort,
  src: s.source,
  direction: s.direction,
  forward: false,
  comment: Buffer.from(s.comment).toString("hex"),
  v6: s.family === "ipv6",
  dapp: "",
  sapp: "",
  logtype: "",
  interface_in: "",
  interface_out: "",
  number,
  group: "",
  raw: JSON.stringify(s),
});
const result = (stdout = "", code = 0, stderr = "") => ({
  stdout,
  code,
  stderr,
});
let rows: ReturnType<typeof ufwRow>[];
let canonical: boolean;
let ip: string;
let nft: Record<string, any>[];
const nftChain = {
  family: "inet",
  table: "filter",
  name: "input",
  type: "filter",
  hook: "input",
  prio: 0,
  policy: "drop",
};
const nftRule = {
  family: "inet",
  table: "filter",
  chain: "input",
  handle: 11,
  expr: [
    {
      match: {
        op: "==",
        left: { payload: { protocol: "tcp", field: "dport" } },
        right: 443,
      },
    },
    { accept: null },
  ],
};
function backend(type = "ufw") {
  mocks.collect.mockResolvedValue({
    type,
    status: "active",
    chains: [
      { name: "INPUT", policy: type === "ufw" ? "DENY" : "DROP", rules: [] },
      {
        name: "OUTPUT",
        policy: type === "ufw" ? "ALLOW" : "ACCEPT",
        rules: [],
      },
    ],
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  backend();
  rows = [ufwRow()];
  canonical = true;
  ip =
    "*filter\n:INPUT DROP [0:0]\n:OUTPUT ACCEPT [0:0]\n-A INPUT -p tcp --dport 443 -j ACCEPT\nCOMMIT\n";
  nft = [{ chain: { ...nftChain } }, { rule: structuredClone(nftRule) }];
  mocks.read.mockImplementation(async (_c, tool) =>
    tool === "iptables-save"
      ? result(ip)
      : tool === "nft"
        ? result(JSON.stringify({ nftables: nft }))
        : null,
  );
  mocks.exec.mockImplementation(async (_c, cmd: string) =>
    cmd.includes("/usr/bin/python3")
      ? result(
          JSON.stringify({
            rows,
            canonical,
            config: ["config"],
            rawfiles: [],
            ipv6: true,
          }),
        )
      : result("ok"),
  );
});
const writes = () =>
  mocks.exec.mock.calls.filter(([, cmd]) => !cmd.includes("/usr/bin/python3"));
const state = () => readManagement(client, undefined, 7);
const request = async (op = "delete", extra: Record<string, unknown> = {}) => {
  const s = await state();
  return mutateManaged(client, undefined, 7, {
    op,
    id: s.view.managedRules[0]?.id,
    snapshot: s.view.snapshot,
    ...extra,
  });
};

describe("firewall identity and validation", () => {
  it("isolates root Python imports and uses only system tool directories", async () => {
    await state();
    const command = mocks.exec.mock.calls.find(([, cmd]) =>
      cmd.includes("/usr/bin/python3"),
    )?.[1];
    expect(command).toContain("cd / && /usr/bin/python3 -I -B -c ");
    expect(command).toContain('PATH="/usr/sbin:/usr/bin:/sbin:/bin"');
    expect(command).not.toContain("$PATH");
  });
  it("uses a read-only, version-pinned UFW parser probe, not firewall mutation or capability initialization", () => {
    expect(UFW_PROBE).toContain("UFWBackendIptables.__new__");
    expect(UFW_PROBE).not.toMatch(
      /\.set_rule\(|\.initcaps\(|UFWBackendIptables\(False/,
    );
    expect(UFW_PROBE).toContain("'ufw 0.36.2'");
  });
  it("binds snapshots to host and detects changed order/spec/policy, not traffic counters", async () => {
    const s = await state();
    expect((await readManagement(client, undefined, 8)).view.snapshot).not.toBe(
      s.view.snapshot,
    );
    rows = [ufwRow({ ...spec, port: "80" })];
    await expect(
      mutateManaged(client, undefined, 7, {
        op: "delete",
        id: s.view.managedRules[0].id,
        snapshot: s.view.snapshot,
      }),
    ).rejects.toThrow("Firewall changed");
    expect(writes()).toHaveLength(0);
    backend("iptables");
    const a = await state();
    ip = ip.replaceAll("[0:0]", "[40:4000]");
    expect((await state()).view.snapshot).toBe(a.view.snapshot);
  });
  it.each([
    "source",
    "destination",
    "port",
    "sourcePort",
    "family",
    "protocol",
    "action",
    "direction",
  ] as const)("rejects injection in %s without a write", async (field) => {
    await expect(
      request("edit", { spec: { ...spec, [field]: "443; touch /tmp/bad" } }),
    ).rejects.toThrow();
    expect(writes()).toHaveLength(0);
  });
  it("accepts UFW bare ports with protocol any, and rejects invalid CIDR/family/range", () => {
    expect(
      validateManagedSpec({ ...spec, protocol: "any", port: "8765" }).port,
    ).toBe("8765");
    for (const change of [
      { source: "::/0" },
      { source: "192.0.2.0/33" },
      { sourcePort: "0" },
      { port: "65536" },
      { port: "1:9000" },
      { comment: "bad\ncomment" },
    ])
      expect(() => validateManagedSpec({ ...spec, ...change })).toThrow();
  });
  it.each(["sapp", "logtype", "interface_in", "interface_out"])(
    "keeps %s constraints read-only",
    async (field) => {
      Object.assign(rows[0], { [field]: "restriction" });
      expect((await state()).view.managedRules[0].readOnlyReason).toBeTruthy();
      await expect(request()).rejects.toThrow("read-only");
      expect(writes()).toHaveLength(0);
    },
  );
  it("keeps malformed/custom UFW files, LIMIT, forward and expanded profile offsets read-only", async () => {
    for (const patch of [
      { action: "limit" },
      { forward: true },
      { number: 2 },
    ]) {
      rows = [Object.assign(ufwRow(), patch)];
      expect((await state()).view.managedRules[0].spec).toBeUndefined();
    }
    rows = [ufwRow()];
    canonical = false;
    const s = await state();
    expect(s.view.managedRules[0].spec).toBeUndefined();
    expect(s.view.policies).toEqual([]);
  });
  it("fails closed and displays fallback metrics if UFW Python layout is unavailable", async () => {
    mocks.exec.mockResolvedValue(result("", 1, "no Python"));
    const s = await state();
    expect(s.view.managementWarning).toContain("read-only");
    expect(s.view.policies).toEqual([]);
    expect(s.view.managedRules).toEqual([]);
  });
  it("rejects noncanonical UFW policy requests without issuing mutations", async () => {
    canonical = false;
    const s = await state();
    await expect(
      mutateManaged(client, undefined, 7, {
        op: "policy",
        id: "INPUT",
        value: "reject",
        snapshot: s.view.snapshot,
      }),
    ).rejects.toThrow("Unsupported policy or chain");
    expect(writes()).toHaveLength(0);
  });
});

describe("UFW numbered mutations", () => {
  it("preserves a single-expansion destination profile by name, never reconstructing its port", async () => {
    const profile = { ...spec, profile: "OpenSSH", port: "22" };
    const next = { ...profile, action: "deny" as const };
    const record = (s: ManagedRuleSpec, number = 1) => ({
      ...ufwRow(s, number),
      dapp: "OpenSSH",
      group: `OpenSSH-${s.action}`,
    });
    rows = [record(profile)];
    mocks.exec.mockImplementation(async (_c, cmd: string) => {
      if (cmd.includes("ufw 'deny'")) rows = [record(next)];
      return cmd.includes("python3")
        ? result(
            JSON.stringify({
              rows,
              canonical: true,
              config: [],
              rawfiles: [],
              ipv6: true,
            }),
          )
        : result();
    });
    expect((await request("edit", { spec: next })).success).toBe(true);
    expect(writes()[0][1]).toContain("'app' 'OpenSSH'");
    expect(writes()[0][1]).not.toContain("'proto'");
    expect(writes()[0][1]).not.toContain("'22'");
    expect(writes()).toHaveLength(1);
  });
  it("rejects client profile/port/protocol substitutions and multi-expansion profile groups", async () => {
    rows = [
      { ...ufwRow({ ...spec, port: "22" }), dapp: "OpenSSH", group: "ssh" },
    ];
    const s = await state();
    const original = s.view.managedRules[0].spec!;
    expect(original.profile).toBe("OpenSSH");
    for (const patch of [
      { profile: "Other" },
      { port: "23" },
      { protocol: "udp" },
    ])
      await expect(
        request("edit", { spec: { ...original, ...patch } }),
      ).rejects.toThrow("preserved");
    rows.push({ ...rows[0], number: undefined as never });
    expect((await state()).view.managedRules.every((r) => !r.spec)).toBe(true);
    expect(writes()).toHaveLength(0);
  });
  it("deletes exactly one numbered family rule and verifies surrounding order", async () => {
    rows = [
      ufwRow(),
      ufwRow(
        { ...spec, family: "ipv6", source: "::/0", destination: "::/0" },
        2,
      ),
    ];
    const s = await state();
    mocks.exec.mockImplementation(async (_c, cmd: string) => {
      if (cmd.includes("--force delete 2")) rows = rows.slice(0, 1);
      return cmd.includes("python3")
        ? result(
            JSON.stringify({
              rows,
              canonical: true,
              config: [],
              rawfiles: [],
              ipv6: true,
            }),
          )
        : result();
    });
    // Same topology as the fresh request snapshot.
    const fresh = await state();
    await mutateManaged(client, undefined, 7, {
      op: "delete",
      id: s.view.managedRules[1].id,
      snapshot: fresh.view.snapshot,
    });
    expect(writes()[0][1]).toContain("ufw --force delete 2");
    expect(rows).toHaveLength(1);
  });
  it("inserts explicit-family full fields before deleting a freshly identified original", async () => {
    const next = { ...spec, port: "8443" };
    mocks.exec.mockImplementation(async (_c, cmd: string) => {
      if (cmd.includes("ufw 'insert'")) rows = [ufwRow(next), ufwRow(spec, 2)];
      if (cmd.includes("--force delete 2")) rows = rows.slice(0, 1);
      return cmd.includes("python3")
        ? result(
            JSON.stringify({
              rows,
              canonical: true,
              config: [],
              rawfiles: [],
              ipv6: true,
            }),
          )
        : result();
    });
    expect((await request("edit", { spec: next })).success).toBe(true);
    expect(writes()[0][1]).toContain(
      "'from' '192.0.2.0/24' 'to' '0.0.0.0/0' 'port' '8443'",
    );
    expect(writes()[0][1]).toContain(`'comment' 'keep '\"'\"' this'`);
    expect(writes()[1][1]).toContain("--force delete 2");
  });
  it.each(["skip", "reorder", "expand", "timeout"])(
    "never deletes original after insertion %s",
    async (mode) => {
      mocks.exec.mockImplementation(async (_c, cmd: string) => {
        if (cmd.includes("ufw 'insert'")) {
          if (mode === "timeout") throw Error("timeout");
          if (mode === "reorder")
            rows = [ufwRow(spec), ufwRow({ ...spec, port: "8443" }, 2)];
          if (mode === "expand")
            rows = [
              ufwRow({ ...spec, port: "8443" }),
              ufwRow({ ...spec, port: "8443" }, 2),
              ufwRow(spec, 3),
            ];
        }
        return cmd.includes("python3")
          ? result(
              JSON.stringify({
                rows,
                canonical: true,
                config: [],
                rawfiles: [],
                ipv6: true,
              }),
            )
          : result("Skipping existing rule");
      });
      await expect(
        request("edit", { spec: { ...spec, port: "8443" } }),
      ).rejects.toThrow("not atomic");
      expect(writes()).toHaveLength(1);
      expect(writes()[0][1]).not.toContain("delete");
    },
  );
  it("reports a partial replacement if deleting the original fails, without rollback/retry", async () => {
    mocks.exec.mockImplementation(async (_c, cmd: string) => {
      if (cmd.includes("ufw 'insert'"))
        rows = [ufwRow({ ...spec, port: "8443" }), ufwRow(spec, 2)];
      if (cmd.includes("--force delete")) return result("", 1, "delete failed");
      return cmd.includes("python3")
        ? result(
            JSON.stringify({
              rows,
              canonical: true,
              config: [],
              rawfiles: [],
              ipv6: true,
            }),
          )
        : result();
    });
    await expect(
      request("edit", { spec: { ...spec, port: "8443" } }),
    ).rejects.toThrow("partially applied");
    expect(writes()).toHaveLength(2);
    expect(rows).toHaveLength(2);
  });
});

describe("native replacements and default policies", () => {
  it("replaces native iptables in place with explicit chain, family, index and lock", async () => {
    backend("iptables");
    const s = await state();
    const next = { ...s.view.managedRules[0].spec!, port: "8443" };
    mocks.exec.mockImplementation(async () => {
      ip = ip.replace("443", "8443");
      return result();
    });
    await mutateManaged(client, undefined, 7, {
      op: "edit",
      id: s.view.managedRules[0].id,
      snapshot: s.view.snapshot,
      spec: next,
    });
    expect(writes()[0][1]).toContain(
      "iptables '-w' '5' '-t' 'filter' '-R' 'INPUT' '1'",
    );
    expect(writes()[0][1]).not.toContain("-D");
  });
  it("keeps unknown iptables matches/comments/user chains read-only", async () => {
    backend("iptables");
    ip = ip.replace("-p tcp", "-m conntrack --ctstate NEW -p tcp");
    const row = (await state()).view.managedRules[0];
    expect(row.spec).toBeUndefined();
    expect(row.target).toBe("-");
    expect(row.source).toBe("-");
    expect(row.description).toContain("--ctstate NEW");
  });
  it("uses nft JSON handle replace, never a lossy port lookup", async () => {
    backend("nftables");
    const s = await state();
    const next = { ...s.view.managedRules[0].spec!, port: "8443" };
    mocks.exec.mockImplementation(async () => {
      nft[1].rule.expr[0].match.right = 8443;
      return result();
    });
    await mutateManaged(client, undefined, 7, {
      op: "edit",
      id: s.view.managedRules[0].id,
      snapshot: s.view.snapshot,
      spec: next,
    });
    expect(writes()[0][1]).toContain(
      "nft 'replace' 'rule' 'inet' 'filter' 'input' 'handle' '11'",
    );
  });
  it("does not discard extra nft expressions or comments", async () => {
    backend("nftables");
    nft[1].rule.expr.unshift({ counter: { packets: 1, bytes: 2 } });
    expect((await state()).view.managedRules[0].spec).toBeUndefined();
    const s = await state();
    expect(s.view.managedRules[0].target).toBe("-");
    expect(s.view.managedRules[0].source).toBe("-");
    nft[1].rule.expr[0].counter.packets++;
    expect((await state()).view.snapshot).toBe(s.view.snapshot);
  });
  it.each(["ufw", "iptables", "nftables"])(
    "changes only supported INPUT/OUTPUT policies for %s",
    async (type) => {
      backend(type);
      const s = await state();
      const p = s.view.policies[0];
      expect(p).toBeTruthy();
      const value =
        type === "ufw" ? "allow" : type === "iptables" ? "ACCEPT" : "accept";
      mocks.exec.mockImplementation(async () => {
        if (type === "ufw")
          mocks.collect.mockResolvedValue({
            ...s.view,
            chains: s.view.chains.map((c) => ({
              ...c,
              policy: c.name === "INPUT" ? "ALLOW" : c.policy,
            })),
          });
        if (type === "iptables")
          ip = ip.replace(":INPUT DROP", ":INPUT ACCEPT");
        if (type === "nftables") nft[0].chain.policy = "accept";
        return result(
          JSON.stringify({
            rows,
            canonical: true,
            config: ["config"],
            rawfiles: [],
            ipv6: true,
          }),
        );
      });
      await mutateManaged(client, undefined, 7, {
        op: "policy",
        id: p.id,
        value,
        snapshot: s.view.snapshot,
      });
      expect(writes()).toHaveLength(1);
      expect(writes()[0][1]).toContain(
        type === "ufw"
          ? "'incoming'"
          : type === "iptables"
            ? "'-P' 'INPUT' 'ACCEPT'"
            : "'policy' 'accept'",
      );
    },
  );
  it.each([
    { id: "FORWARD", value: "allow" },
    { id: "INPUT", value: "allow; evil" },
    { id: "INPUT", value: "ACCEPT" },
  ])("rejects unsupported chain/policy %j", async (body) => {
    const s = await state();
    await expect(
      mutateManaged(client, undefined, 7, {
        op: "policy",
        snapshot: s.view.snapshot,
        ...body,
      }),
    ).rejects.toThrow("Unsupported");
    expect(writes()).toHaveLength(0);
  });
  it("serializes same-host operations including a failed action but allows another host", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const trace: string[] = [];
    const a = withFirewallLock(7, async () => {
      trace.push("a");
      await gate;
      throw Error("failed");
    });
    const failure = expect(a).rejects.toThrow("failed");
    const b = withFirewallLock(7, async () => {
      trace.push("b");
    });
    await withFirewallLock(8, async () => {
      trace.push("other");
    });
    expect(trace).toEqual(["a", "other"]);
    release();
    await Promise.all([failure, b]);
    expect(trace).toEqual(["a", "other", "b"]);
  });
});
