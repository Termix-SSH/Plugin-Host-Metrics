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

const ACTIVE = `Status: active
Logging: on (low)
Default: deny (incoming), allow (outgoing), disabled (routed)
New profiles: skip

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW IN    Anywhere
80,443/tcp                 ALLOW IN    192.168.1.0/24
OpenSSH                    LIMIT IN    Anywhere
53/udp                     ALLOW OUT   Anywhere
22/tcp (v6)                ALLOW IN    Anywhere (v6)
`;

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

  it("reports an inactive ufw and ignores other output", () => {
    expect(parseUfwStatus("Status: inactive\n")).toEqual({
      type: "ufw",
      status: "inactive",
      chains: [],
    });
    expect(parseUfwStatus("ufw: command not found")).toBeNull();
  });
});

const NFT = `table inet filter {
	chain input {
		type filter hook input priority filter; policy drop;
		tcp dport 22 accept
	}
}
`;

describe("collectFirewallMetrics", () => {
  const client = {} as Client;

  beforeEach(() => {
    execCommand.mockReset();
    execElevated.mockReset();
  });

  // Only nft is installed and it needs root to read the ruleset.
  function nftNeedsRoot() {
    execCommand.mockImplementation(async (_c: Client, cmd: string) => {
      if (cmd.includes("command -v nft")) {
        return { stdout: "/usr/sbin/nft\n", stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 1 };
    });
  }

  it("never runs sudo without a saved sudo password", async () => {
    nftNeedsRoot();
    const result = await collectFirewallMetrics(client);
    expect(result.type).toBe("none");
    expect(execElevated).not.toHaveBeenCalled();
    for (const [, cmd] of execCommand.mock.calls) {
      expect(cmd).not.toContain("sudo");
    }
  });

  it("skips tools that are not installed", async () => {
    nftNeedsRoot();
    await collectFirewallMetrics(client);
    const commands = execCommand.mock.calls.map(([, cmd]) => cmd as string);
    expect(commands.some((cmd) => cmd.startsWith("/usr/sbin/nft "))).toBe(true);
    expect(commands.filter((cmd) => !cmd.includes("command -v"))).toEqual([
      "/usr/sbin/nft list ruleset 2>/dev/null",
    ]);
  });

  it("elevates with the full path when a sudo password is saved", async () => {
    nftNeedsRoot();
    execElevated.mockResolvedValue({ stdout: NFT, stderr: "", code: 0 });
    const result = await collectFirewallMetrics(client, "secret");
    expect(execElevated).toHaveBeenCalledTimes(1);
    expect(execElevated).toHaveBeenCalledWith(
      client,
      "/usr/sbin/nft list ruleset",
      "secret",
      expect.objectContaining({ forceSudo: true }),
    );
    expect(result.type).toBe("nftables");
  });
});
