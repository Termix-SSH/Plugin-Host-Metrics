import { describe, it, expect } from "vitest";
import {
  buildSudoCommand,
  shellSingleQuote,
  parsePlatformProbe,
  buildPackageActionCommand,
  parseUpgradable,
  buildListUpgradableCommand,
} from "@termix-ssh/plugin-sdk/host-commands";
import {
  isValidPid,
  isValidPort,
  isValidPackageName,
  isValidUsername,
  isValidDomain,
  isValidDnsProvider,
  isValidSignal,
  isAllowedPath,
} from "../../../src/backend/managers/validation.js";
import {
  parseProcessList,
  buildKillCommand,
} from "../../../src/backend/managers/processes.js";
import {
  parseDfMounts,
  parseTopMemory,
} from "../../../src/backend/managers/simple-reads.js";
import {
  parseCrontab,
  crontabPreamble,
  serializeCrontab,
  isValidCronSchedule,
  buildApplyCrontabCommand,
} from "../../../src/backend/managers/cron.js";
import {
  buildIssueCommand,
  buildRenewCommand,
  buildRevokeCommand,
  isValidCertName,
  parseCertbotCertificates,
} from "../../../src/backend/managers/ssl.js";
import {
  parsePasswd,
  parseSudoers,
} from "../../../src/backend/managers/users.js";
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
  it("pids", () => {
    expect(isValidPid(123)).toBe(true);
    expect(isValidPid("123")).toBe(true);
    expect(isValidPid(0)).toBe(false);
    expect(isValidPid("1; reboot")).toBe(false);
    expect(isValidPid(-5)).toBe(false);
  });
  it("ports", () => {
    expect(isValidPort(443)).toBe(true);
    expect(isValidPort(0)).toBe(false);
    expect(isValidPort(70000)).toBe(false);
  });
  it("package names", () => {
    expect(isValidPackageName("nginx")).toBe(true);
    expect(isValidPackageName("lib-foo.bar+1")).toBe(true);
    expect(isValidPackageName("nginx && curl evil")).toBe(false);
    expect(isValidPackageName("-rf")).toBe(false);
  });
  it("usernames and domains", () => {
    expect(isValidUsername("deploy")).toBe(true);
    expect(isValidUsername("root; rm")).toBe(false);
    expect(isValidDomain("example.com")).toBe(true);
    expect(isValidDomain("*.example.com")).toBe(true);
    expect(isValidDomain("ex ample.com")).toBe(false);
    expect(isValidDomain("a;b.com")).toBe(false);
  });
  it("dns providers and signals", () => {
    expect(isValidDnsProvider("cloudflare")).toBe(true);
    expect(isValidDnsProvider("cf; rm")).toBe(false);
    expect(isValidSignal("KILL")).toBe(true);
    expect(isValidSignal("BOOM")).toBe(false);
  });
  it("path allowlist rejects traversal and out-of-allowlist", () => {
    expect(isAllowedPath("/var/log/syslog", ["/var/log"])).toBe(true);
    expect(isAllowedPath("/var/log/../../etc/passwd", ["/var/log"])).toBe(
      false,
    );
    expect(isAllowedPath("/etc/passwd", ["/var/log"])).toBe(false);
    expect(isAllowedPath("relative/path", ["/var/log"])).toBe(false);
  });
});

describe("processes", () => {
  it("parses ps output", () => {
    const out =
      "1234 1 root 12.5 3.2 45000 S /usr/bin/node node server.js\n" +
      "5678 1234 deploy 0.0 1.1 12000 Sl bash -bash";
    const rows = parseProcessList(out);
    expect(rows[0]).toMatchObject({
      pid: 1234,
      user: "root",
      cpu: 12.5,
      command: "/usr/bin/node",
    });
    expect(rows[1].pid).toBe(5678);
  });
  it("builds kill command", () => {
    expect(buildKillCommand(42, "TERM")).toBe("kill -TERM 42");
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

describe("cron", () => {
  it("parses enabled and toggled entries", () => {
    const out = "0 2 * * * /backup.sh\n# 30 4 * * * /old.sh\nPATH=/usr/bin";
    const entries = parseCrontab(out);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ enabled: true, schedule: "0 2 * * *" });
    expect(entries[1].enabled).toBe(false);
  });
  it("does not read plain comments as disabled jobs", () => {
    const out =
      "# Edit this file to introduce tasks to be run by cron.\n# m h  dom mon dow   command\n0 2 * * * /backup.sh";
    const entries = parseCrontab(out);
    expect(entries).toHaveLength(1);
    expect(entries[0].command).toBe("/backup.sh");
  });
  it("keeps variables and comments when jobs are rewritten", () => {
    const out =
      "MAILTO=me@example.com\n# notes here\n0 2 * * * /a.sh\n# 30 4 * * * /old.sh\nshell_opts=1\n";
    expect(crontabPreamble(out)).toBe(
      "MAILTO=me@example.com\n# notes here\nshell_opts=1\n",
    );
    expect(crontabPreamble("0 2 * * * /a.sh\n")).toBe("");
  });
  it("validates schedules", () => {
    expect(isValidCronSchedule("0 2 * * *")).toBe(true);
    expect(isValidCronSchedule("@daily")).toBe(true);
    expect(isValidCronSchedule("not a schedule")).toBe(false);
  });
  it("serializes (commenting disabled entries) and round-trips", () => {
    const body = serializeCrontab([
      { raw: "", enabled: true, schedule: "0 2 * * *", command: "/a.sh" },
      { raw: "", enabled: false, schedule: "@daily", command: "/b.sh" },
    ]);
    expect(body).toBe("0 2 * * * /a.sh\n# @daily /b.sh\n");
    const reparsed = parseCrontab(body);
    expect(reparsed[0].enabled).toBe(true);
    expect(reparsed[1].enabled).toBe(false);
  });
  it("builds apply command piping into crontab -", () => {
    expect(buildApplyCrontabCommand("x\n")).toBe(
      `printf '%s' 'x\n' | crontab -`,
    );
  });
});

describe("packages", () => {
  it("builds per-distro commands", () => {
    expect(buildPackageActionCommand("apt", "install", "nginx")).toContain(
      "apt-get -y install nginx",
    );
    expect(buildPackageActionCommand("pacman", "upgrade-all")).toBe(
      "pacman -Syu --noconfirm",
    );
    expect(buildPackageActionCommand(null, "install", "x")).toBeNull();
  });
  it("lists per distro", () => {
    expect(buildListUpgradableCommand("apt")).toContain(
      "apt list --upgradable",
    );
    expect(buildListUpgradableCommand(null)).toBeNull();
  });
  it("parses apt upgradable", () => {
    const out =
      "nginx/focal-updates 1.18.0-2 amd64 [upgradable from: 1.18.0-1]";
    const pkgs = parseUpgradable("apt", out);
    expect(pkgs[0]).toMatchObject({
      name: "nginx",
      newVersion: "1.18.0-2",
      currentVersion: "1.18.0-1",
    });
  });
  it("parses pacman upgradable", () => {
    const pkgs = parseUpgradable("pacman", "linux 6.1 -> 6.2");
    expect(pkgs[0]).toMatchObject({ name: "linux", newVersion: "6.2" });
  });
});

describe("ssl (dual client)", () => {
  it("builds certbot issue for http + dns", () => {
    expect(
      buildIssueCommand({
        client: "certbot",
        domains: ["a.com"],
        challenge: "http-standalone",
      }),
    ).toContain(
      "certbot certonly --non-interactive --agree-tos --standalone -d 'a.com'",
    );
    expect(
      buildIssueCommand({
        client: "certbot",
        domains: ["a.com"],
        challenge: "dns",
        dnsProvider: "cloudflare",
      }),
    ).toContain("--dns-cloudflare");
  });
  it("builds acme.sh issue", () => {
    const cmd = buildIssueCommand({
      client: "acme.sh",
      domains: ["a.com", "b.com"],
      challenge: "dns",
      dnsProvider: "cf",
    });
    expect(cmd).toContain("--issue --dns dns_cf");
    expect(cmd).toContain("-d 'a.com'");
    expect(cmd).toContain("-d 'b.com'");
  });
  it("builds renew per client", () => {
    expect(buildRenewCommand("certbot", true)).toBe("certbot renew --dry-run");
    expect(buildRenewCommand("acme.sh", false)).toContain("--renew-all");
    expect(buildRenewCommand("acme.sh", true)).toBeNull();
  });
  it("builds revoke per client", () => {
    expect(buildRevokeCommand("certbot", "example.com")).toBe(
      "certbot revoke --non-interactive --cert-name 'example.com' --delete-after-revoke",
    );
    const acme = buildRevokeCommand("acme.sh", "example.com");
    expect(acme).toContain("--revoke -d 'example.com'");
    expect(acme).toContain("--remove -d 'example.com'");
  });
  it("validates certificate names (rejects shell metachars)", () => {
    expect(isValidCertName("example.com")).toBe(true);
    expect(isValidCertName("example.com-0001")).toBe(true);
    expect(isValidCertName("*.example.com")).toBe(true);
    expect(isValidCertName("a.com; rm -rf /")).toBe(false);
    expect(isValidCertName("")).toBe(false);
    expect(isValidCertName(undefined)).toBe(false);
  });
  it("parses certbot certificates", () => {
    const out = [
      "Found the following certs:",
      "  Certificate Name: example.com",
      "    Domains: example.com www.example.com",
      "    Expiry Date: 2026-09-01 12:00:00+00:00 (VALID: 80 days)",
      "    Certificate Path: /etc/letsencrypt/live/example.com/fullchain.pem",
    ].join("\n");
    const certs = parseCertbotCertificates(out);
    expect(certs[0]).toMatchObject({
      name: "example.com",
      client: "certbot",
    });
    expect(certs[0].domains).toContain("www.example.com");
  });
});

describe("users", () => {
  it("parses passwd for human users only", () => {
    const out =
      "root:x:0:0:root:/root:/bin/bash\n" +
      "deploy:x:1000:1000:Deploy:/home/deploy:/bin/bash\n" +
      "nobody:x:65534:65534:nobody:/:/usr/sbin/nologin";
    const users = parsePasswd(out);
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("deploy");
  });
  it("parses sudoers membership", () => {
    const out = "sudo:x:27:deploy,alice\nwheel:x:10:bob";
    expect(parseSudoers(out).sort()).toEqual(["alice", "bob", "deploy"]);
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
