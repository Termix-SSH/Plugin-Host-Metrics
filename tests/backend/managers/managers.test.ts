import { describe, it, expect } from "vitest";
import {
  buildSudoCommand,
  shellSingleQuote,
  parsePlatformProbe,
} from "@termix-ssh/plugin-sdk/host-commands";
import { isValidPort } from "../../../src/backend/managers/validation.js";
import {
  parseDfMounts,
  parseTopMemory,
} from "../../../src/backend/managers/simple-reads.js";
import {
  buildHealthCheckCommand,
  parseHealthResult,
} from "../../../src/backend/managers/health.js";

describe("exec-elevated", () => {
  it("single-quotes and escapes for the shell", () => {
    expect(shellSingleQuote("abc")).toBe("'abc'");
    expect(shellSingleQuote("a'b")).toBe(`'a'"'"'b'`);
  });
  it("builds the sudo -S pipeline wrapping the command in sh -c with a success marker", () => {
    expect(buildSudoCommand("systemctl restart nginx", "pw")).toBe(
      `echo 'pw' | sudo -S -p '' sh -c 'echo __TX_SUDO_OK__; systemctl restart nginx'`,
    );
  });
  it("does not merge stderr into stdout (no 2>&1)", () => {
    expect(buildSudoCommand("id", "pw")).not.toContain("2>&1");
  });
  it("escapes a password containing a quote", () => {
    expect(buildSudoCommand("id", "p'w")).toContain(`echo 'p'"'"'w'`);
  });
});

describe("platform probe parsing", () => {
  it("parses capabilities and prefers dnf over yum", () => {
    const out = [
      "systemd=1",
      "apt=0",
      "dnf=1",
      "yum=1",
      "pacman=0",
      "certbot=1",
      "acmesh=0",
      "docker=1",
      "os=Fedora Linux 40",
    ].join("\n");
    const p = parsePlatformProbe(out);
    expect(p.hasSystemd).toBe(true);
    expect(p.pkg).toBe("dnf");
    expect(p.hasCertbot).toBe(true);
    expect(p.hasAcmeSh).toBe(false);
    expect(p.hasDocker).toBe(true);
    expect(p.osPrettyName).toBe("Fedora Linux 40");
  });
  it("picks apt when present", () => {
    expect(parsePlatformProbe("apt=1\ndnf=1").pkg).toBe("apt");
  });
});

describe("validation (injection defense)", () => {
  it("ports", () => {
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(70000)).toBe(false);
  });
});

describe("simple reads", () => {
  it("parses df -Pk and skips tmpfs", () => {
    const out =
      "/dev/sda1 100000 40000 60000 40% /\n" +
      "tmpfs 8000 0 8000 0% /dev/shm\n" +
      "/dev/sdb1 200000 100000 100000 50% /data";
    const mounts = parseDfMounts(out);
    expect(mounts).toHaveLength(2);
    expect(mounts[0].mount).toBe("/");
    expect(mounts[1].usePct).toBe(50);
  });
  it("parses top by memory", () => {
    const rows = parseTopMemory("1234 root 5.5 50000 node");
    expect(rows[0]).toMatchObject({ pid: 1234, mem: 5.5, command: "node" });
  });
});

describe("health checks", () => {
  it("builds tcp and http commands", () => {
    const tcp = buildHealthCheckCommand({
      id: "1",
      name: "ssh",
      type: "tcp",
      target: "localhost",
      port: 22,
    });
    expect(tcp).toContain("/dev/tcp/");
    const http = buildHealthCheckCommand({
      id: "2",
      name: "web",
      type: "http",
      target: "example.com",
      path: "/health",
    });
    expect(http).toContain("curl -s -o /dev/null");
    expect(http).toContain("http://example.com/health");
  });
  it("parses tcp and http results", () => {
    const tcp = parseHealthResult(
      { id: "1", name: "ssh", type: "tcp", target: "h", port: 22 },
      "ok 12",
    );
    expect(tcp).toMatchObject({ ok: true, latencyMs: 12 });
    const http = parseHealthResult(
      { id: "2", name: "web", type: "http", target: "h" },
      "200 0.045",
    );
    expect(http).toMatchObject({ ok: true, latencyMs: 45 });
    const bad = parseHealthResult(
      { id: "3", name: "web", type: "http", target: "h" },
      "500 0.01",
    );
    expect(bad.ok).toBe(false);
  });
});
