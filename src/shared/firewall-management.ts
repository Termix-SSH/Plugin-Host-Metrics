import type { FirewallMetrics, FirewallRule } from "./stats-widgets.js";

export interface ManagedRuleSpec {
  family: "ipv4" | "ipv6" | "inet";
  direction: "in" | "out";
  action: "allow" | "deny" | "reject";
  protocol: "tcp" | "udp" | "any";
  source: string;
  destination: string;
  port: string;
  sourcePort: string;
  comment: string;
  /** Discovered single-expansion UFW destination profile; never a port translation. */
  profile?: string;
}

export interface ManagedFirewallRule extends FirewallRule {
  id: string;
  description: string;
  family?: ManagedRuleSpec["family"];
  direction?: ManagedRuleSpec["direction"];
  profile?: string;
  spec?: ManagedRuleSpec;
  readOnlyReason?: string;
}

export interface ManagedFirewallPolicy {
  id: string;
  chain: string;
  family: string;
  value: string;
  choices: string[];
  description?: string;
}

export interface FirewallManagement extends FirewallMetrics {
  hostId: number;
  snapshot: string;
  managedRules: ManagedFirewallRule[];
  policies: ManagedFirewallPolicy[];
  managementWarning?: string;
}
