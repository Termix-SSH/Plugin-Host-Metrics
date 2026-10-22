import {
  execCommand,
  execElevated,
  type ExecResult,
} from "@termix-ssh/plugin-sdk/host-commands";
import type { Client } from "ssh2";
import type {
  FirewallMetrics,
  FirewallChain,
  FirewallRule,
} from "../../shared/stats-widgets.js";

function parseIptablesRule(line: string): FirewallRule | null {
  if (!line.startsWith("-A ")) return null;

  const rule: FirewallRule = {
    chain: "",
    target: "",
    protocol: "all",
    source: "0.0.0.0/0",
    destination: "0.0.0.0/0",
  };

  const chainMatch = line.match(/^-A\s+(\S+)/);
  if (chainMatch) {
    rule.chain = chainMatch[1];
  }

  const targetMatch = line.match(/-j\s+(\S+)/);
  if (targetMatch) {
    rule.target = targetMatch[1];
  }

  const protocolMatch = line.match(/-p\s+(\S+)/);
  if (protocolMatch) {
    rule.protocol = protocolMatch[1];
  }

  const sourceMatch = line.match(/-s\s+(\S+)/);
  if (sourceMatch) {
    rule.source = sourceMatch[1];
  }

  const destMatch = line.match(/-d\s+(\S+)/);
  if (destMatch) {
    rule.destination = destMatch[1];
  }

  const dportMatch = line.match(/--dport\s+(\S+)/);
  if (dportMatch) {
    rule.dport = dportMatch[1];
  }

  const sportMatch = line.match(/--sport\s+(\S+)/);
  if (sportMatch) {
    rule.sport = sportMatch[1];
  }

  const stateMatch = line.match(/--state\s+(\S+)/);
  if (stateMatch) {
    rule.state = stateMatch[1];
  }

  const interfaceMatch = line.match(/-i\s+(\S+)/);
  if (interfaceMatch) {
    rule.interface = interfaceMatch[1];
  }

  return rule;
}

function parseIptablesOutput(output: string): FirewallChain[] {
  const chains: Map<string, FirewallChain> = new Map();
  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    const policyMatch = trimmed.match(/^:(\S+)\s+(\S+)/);
    if (policyMatch) {
      const [, chainName, policy] = policyMatch;
      chains.set(chainName, {
        name: chainName,
        policy: policy,
        rules: [],
      });
      continue;
    }

    const rule = parseIptablesRule(trimmed);
    if (rule) {
      let chain = chains.get(rule.chain);
      if (!chain) {
        chain = {
          name: rule.chain,
          policy: "ACCEPT",
          rules: [],
        };
        chains.set(rule.chain, chain);
      }
      chain.rules.push(rule);
    }
  }

  return Array.from(chains.values());
}

function parseNftablesOutput(output: string): FirewallChain[] {
  const chains: FirewallChain[] = [];
  let currentChain: FirewallChain | null = null;

  const lines = output.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    const chainMatch = trimmed.match(/^chain\s+(\S+)\s*\{/);
    if (chainMatch) {
      if (currentChain) {
        chains.push(currentChain);
      }
      currentChain = {
        name: chainMatch[1].toUpperCase(),
        policy: "ACCEPT",
        rules: [],
      };
      continue;
    }

    if (currentChain && /^(type|policy)\s/.test(trimmed)) {
      const policyMatch = trimmed.match(/\bpolicy\s+(\w+)\s*;/);
      if (policyMatch) {
        currentChain.policy = policyMatch[1].toUpperCase();
      }
      continue;
    }

    if (currentChain && trimmed && !trimmed.startsWith("}")) {
      const rule: FirewallRule = {
        chain: currentChain.name,
        target: "",
        protocol: "all",
        source: "0.0.0.0/0",
        destination: "0.0.0.0/0",
      };

      if (trimmed.includes("accept")) rule.target = "ACCEPT";
      else if (trimmed.includes("drop")) rule.target = "DROP";
      else if (trimmed.includes("reject")) rule.target = "REJECT";

      const tcpMatch = trimmed.match(/tcp\s+dport\s+(\S+)/);
      if (tcpMatch) {
        rule.protocol = "tcp";
        rule.dport = tcpMatch[1];
      }

      const udpMatch = trimmed.match(/udp\s+dport\s+(\S+)/);
      if (udpMatch) {
        rule.protocol = "udp";
        rule.dport = udpMatch[1];
      }

      const saddrMatch = trimmed.match(/saddr\s+(\S+)/);
      if (saddrMatch) {
        rule.source = saddrMatch[1];
      }

      const daddrMatch = trimmed.match(/daddr\s+(\S+)/);
      if (daddrMatch) {
        rule.destination = daddrMatch[1];
      }

      const iifMatch = trimmed.match(/iif\s+"?(\S+)"?/);
      if (iifMatch) {
        rule.interface = iifMatch[1].replace(/"/g, "");
      }

      const ctStateMatch = trimmed.match(/ct\s+state\s+(\S+)/);
      if (ctStateMatch) {
        rule.state = ctStateMatch[1].toUpperCase();
      }

      if (rule.target) {
        currentChain.rules.push(rule);
      }
    }

    if (trimmed === "}") {
      if (currentChain) {
        chains.push(currentChain);
        currentChain = null;
      }
    }
  }

  if (currentChain) {
    chains.push(currentChain);
  }

  return chains;
}

/** Parses `ufw status verbose`. */
export function parseUfwStatus(output: string): FirewallMetrics | null {
  const lines = output.split("\n").map((line) => line.trimEnd());
  const statusLine = lines.find((line) => line.startsWith("Status:"));
  if (!statusLine) return null;
  if (!/^Status: (active|inactive)\s*$/.test(statusLine)) return null;
  const active = statusLine.trim() === "Status: active";

  const defaults = lines.find((line) => line.startsWith("Default:")) ?? "";
  const policyFor = (direction: string) =>
    new RegExp(`(\\w+) \\(${direction}\\)`, "i")
      .exec(defaults)?.[1]
      ?.toUpperCase() ?? "-";
  const input: FirewallChain = {
    name: "INPUT",
    policy: policyFor("incoming"),
    rules: [],
  };
  const output_: FirewallChain = {
    name: "OUTPUT",
    policy: policyFor("outgoing"),
    rules: [],
  };

  const header = lines.findIndex((line) => /^--\s+------/.test(line));
  for (const line of header === -1 ? [] : lines.slice(header + 1)) {
    const [to, action, from] = line.trim().split(/\s{2,}/);
    if (!to || !action || !from) continue;
    const [target, direction] = action.split(/\s+/);
    const [port, protocol] = to.replace(/\s*\(v6\)$/, "").split("/");
    const anyAddress = /\(v6\)/.test(to + from) ? "::/0" : "0.0.0.0/0";
    const anywhere = (value: string) =>
      /^anywhere/i.test(value) ? anyAddress : value;
    const rule: FirewallRule = {
      chain: direction === "OUT" ? "OUTPUT" : "INPUT",
      target: target.toUpperCase(),
      protocol: protocol || "all",
      source: anywhere(from),
      destination: anyAddress,
      ...(/^[\d,:]+$/.test(port) ? { dport: port } : { extra: to }),
    };
    (rule.chain === "OUTPUT" ? output_ : input).rules.push(rule);
  }

  return {
    type: "ufw",
    status: active ? "active" : "inactive",
    chains: active ? [input, output_] : [],
  };
}

// Firewall tools live in sbin, which a normal user's PATH often lacks.
const SBIN_PATH = 'PATH="/usr/sbin:/usr/bin:/sbin:/bin"';

// Never try `sudo -n` blindly: a failed attempt is logged and mailed to the
// admin on every poll. Elevate only with the host's saved sudo password.
export async function readFirewall(
  client: Client,
  tool: string,
  args: string,
  sudoPassword?: string,
  acceptedCodes = [0],
): Promise<ExecResult | null> {
  const which = await execCommand(
    client,
    `${SBIN_PATH} command -v ${tool} 2>/dev/null`,
    15000,
  );
  if (which.code === 1 && !which.stdout.trim() && !which.stderr.trim())
    return null;
  const path = which.stdout.trim();
  if (which.code !== 0 || !/^\/[\w/+.\-]+$/.test(path))
    throw new Error(`Cannot locate ${tool}; firewall detection stopped`);

  const command = `LC_ALL=C ${path} ${args}`.trimEnd();
  let result = await execCommand(client, command, 15000);
  if (result.code !== null && acceptedCodes.includes(result.code))
    return result;
  if (sudoPassword) {
    result = await execElevated(client, command, sudoPassword, {
      forceSudo: true,
      timeoutMs: 15000,
    });
    if (result.code !== null && acceptedCodes.includes(result.code))
      return result;
  }
  throw new Error(
    `Cannot read ${tool} (exit ${result.code ?? "unknown"}); check host permissions and the saved sudo password`,
  );
}

function hasPolicy(chains: FirewallChain[]): boolean {
  return chains.some(
    (c) => c.rules.length > 0 || !["ACCEPT", "-"].includes(c.policy),
  );
}

export async function collectFirewallMetrics(
  client: Client,
  sudoPassword?: string,
  strict = false,
): Promise<FirewallMetrics> {
  try {
    const firewalld = await readFirewall(
      client,
      "firewall-cmd",
      "--state",
      sudoPassword,
      [0, 252],
    );
    if (firewalld) {
      if (firewalld.code === 0 && firewalld.stdout.trim() === "running")
        throw new Error(
          "firewalld is running; manage rules with firewalld, not its underlying iptables/nftables backend",
        );
      if (firewalld.code !== 252 || firewalld.stdout.trim() !== "not running")
        throw new Error(
          "Cannot determine firewalld state; firewall detection stopped",
        );
    }

    const ufwResult = await readFirewall(
      client,
      "ufw",
      "status verbose",
      sudoPassword,
    );
    const ufw = ufwResult && parseUfwStatus(ufwResult.stdout);
    if (ufwResult && !ufw)
      throw new Error("Cannot parse UFW status; firewall detection stopped");
    if (ufw?.status === "active") return ufw;

    const iptablesResult = await readFirewall(
      client,
      "iptables-save",
      "",
      sudoPassword,
    );
    const iptables = (iptablesResult?.stdout ?? "").replace(/\r/g, "");
    const tableBlock = /^\*(\w+)[ \t]*\n([\s\S]*?)^COMMIT[ \t]*$/gm;
    const tables = [...iptables.matchAll(tableBlock)];
    const dataLines = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
    const unparseable = (
      result: ExecResult | null,
      text: string,
      blocks: RegExpMatchArray[],
    ) =>
      result &&
      (result.stderr.trim() ||
        dataLines(text.replace(tableBlock, "")).length > 0 ||
        blocks.some(([, , body]) =>
          dataLines(body).some(
            (line) =>
              !/^:\S+\s+(ACCEPT|DROP|-)\s+\[\d+:\d+\]$/.test(line) &&
              !/^-A\s+\S+\s+/.test(line),
          ),
        ));
    if (unparseable(iptablesResult, iptables, tables))
      throw new Error(
        "Cannot parse complete iptables rules; firewall detection stopped",
      );
    // IPv6 rules can be owned by a different backend than IPv4 and are invisible to nft when legacy.
    const ip6Result = await readFirewall(
      client,
      "ip6tables-save",
      "",
      sudoPassword,
    );
    const ip6 = (ip6Result?.stdout ?? "").replace(/\r/g, "");
    const ip6Tables = [...ip6.matchAll(tableBlock)];
    if (unparseable(ip6Result, ip6, ip6Tables))
      throw new Error(
        "Cannot parse complete ip6tables rules; firewall detection stopped",
      );
    const filter = tables.find(([, name]) => name === "filter")?.[2] ?? "";
    const ipChains = parseIptablesOutput(filter);
    const ipActive = [...tables, ...ip6Tables].some(([, , body]) =>
      hasPolicy(parseIptablesOutput(body)),
    );

    const nftResult = await readFirewall(
      client,
      "nft",
      "list ruleset",
      sudoPassword,
    );
    const nft = nftResult?.stdout ?? "";
    const nftTables = [
      ...nft.matchAll(/^table\s+(\S+)\s+("(?:\\.|[^"\\])*"|[^\s{]+)\s*\{/gm),
    ];
    const nftSyntax = nft
      .replace(/"(?:\\.|[^"\\])*"/g, '""')
      .replace(/#.*$/gm, "");
    let depth = 0;
    let balanced = true;
    for (const char of nftSyntax) {
      if (char === "{") depth++;
      if (char === "}" && --depth < 0) balanced = false;
    }
    if (nft.trim() && (!nftTables.length || !balanced || depth !== 0))
      throw new Error(
        "Cannot parse nftables rules; firewall detection stopped",
      );
    if (/\bufw6?[-_]|\bfirewalld\b/i.test(iptables + "\n" + ip6 + "\n" + nft))
      throw new Error(
        "Raw rules still contain UFW/firewalld ownership markers; resolve the manager state on the host before making changes",
      );

    // Modern iptables/nft do not always print the "managed by iptables-nft" warning, so the proof is: nf_tables headers
    // plus every nft table being an ip/ip6 table that iptables(6)-save also lists. shortcut: inet/bridge/arp stay ambiguous.
    const compat =
      nftTables.length > 0 &&
      tables.length + ip6Tables.length > 0 &&
      (!tables.length || /\(nf_tables\)/.test(iptables)) &&
      (!ip6Tables.length || /\(nf_tables\)/.test(ip6)) &&
      nftTables.every(([, family, name]) =>
        (family === "ip" ? tables : family === "ip6" ? ip6Tables : []).some(
          ([, ipName]) => ipName === name,
        ),
      );
    const warnings = nftResult?.stderr.trim().split("\n").filter(Boolean) ?? [];
    if (
      warnings.length &&
      (!compat ||
        warnings.some(
          (line) =>
            !nftTables.some(
              ([, family, name]) =>
                line.trim() ===
                `# Warning: table ${family} ${name} is managed by iptables-nft, do not touch!`,
            ),
        ))
    )
      throw new Error(
        "Cannot establish nftables ownership; firewall detection stopped",
      );
    if (ipActive && nftTables.length && !compat)
      throw new Error(
        "Mixed or ambiguous iptables/nftables policy; manage rules on the host",
      );

    if (ufw && !filter && !ipActive && !nftTables.length) return ufw;
    if (
      (iptablesResult || ip6Result) &&
      (ipActive || compat || !nftTables.length)
    ) {
      return {
        type: "iptables",
        status: ipActive ? "active" : "inactive",
        chains: ipChains.filter((c) =>
          ["INPUT", "OUTPUT", "FORWARD"].includes(c.name),
        ),
      };
    }
    if (nftResult) {
      const chains = parseNftablesOutput(nft);
      return {
        type: "nftables",
        status: hasPolicy(chains) ? "active" : "inactive",
        chains,
      };
    }
    if (ufw) return ufw;
    if (strict)
      throw new Error("No supported firewall backend found; no changes made");
    return { type: "none", status: "unknown", chains: [] };
  } catch (error) {
    if (strict) throw error;
    return {
      type: "none",
      status: "unknown",
      chains: [],
    };
  }
}
