import { execCommand } from "@termix-ssh/plugin-sdk/host-commands";
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

    const chainMatch = trimmed.match(
      /chain\s+(\S+)\s*\{?\s*(?:type\s+\S+\s+hook\s+(\S+))?/,
    );
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

    if (currentChain && trimmed.startsWith("policy ")) {
      const policyMatch = trimmed.match(/policy\s+(\S+)/);
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
  const active = /status:\s*active/i.test(statusLine);

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
    const anywhere = (value: string) =>
      /^anywhere/i.test(value) ? "0.0.0.0/0" : value;
    const rule: FirewallRule = {
      chain: direction === "OUT" ? "OUTPUT" : "INPUT",
      target: target.toUpperCase(),
      protocol: protocol || "all",
      source: anywhere(from),
      destination: "0.0.0.0/0",
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

// Firewall tools live in sbin, which a normal user's PATH often lacks. When
// the plain command can't read the rules, try passwordless sudo.
const SBIN_PATH = 'PATH="$PATH:/usr/local/sbin:/usr/sbin:/sbin"';

async function readFirewall(client: Client, command: string): Promise<string> {
  for (const prefix of ["", "sudo -n "]) {
    const result = await execCommand(
      client,
      `${SBIN_PATH} ${prefix}${command} 2>/dev/null`,
      15000,
    );
    if (result.stdout?.trim()) return result.stdout;
  }
  return "";
}

export async function collectFirewallMetrics(
  client: Client,
): Promise<FirewallMetrics> {
  try {
    const iptables = await readFirewall(client, "iptables-save");
    if (iptables.includes("*filter")) {
      const chains = parseIptablesOutput(iptables);
      const hasRules = chains.some((c) => c.rules.length > 0);

      return {
        type: "iptables",
        status: hasRules ? "active" : "inactive",
        chains: chains.filter(
          (c) =>
            c.name === "INPUT" || c.name === "OUTPUT" || c.name === "FORWARD",
        ),
      };
    }

    const nft = await readFirewall(client, "nft list ruleset");
    if (nft.trim()) {
      const chains = parseNftablesOutput(nft);
      const hasRules = chains.some((c) => c.rules.length > 0);

      return {
        type: "nftables",
        status: hasRules ? "active" : "inactive",
        chains,
      };
    }

    const ufw = parseUfwStatus(
      await readFirewall(client, "ufw status verbose"),
    );
    if (ufw) return ufw;

    return {
      type: "none",
      status: "unknown",
      chains: [],
    };
  } catch {
    return {
      type: "none",
      status: "unknown",
      chains: [],
    };
  }
}
