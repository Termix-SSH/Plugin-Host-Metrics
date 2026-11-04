/**
 * Strict allowlist validators for every dynamic value that reaches a shell
 * command. Managers MUST validate inputs through these before interpolation;
 * never pass raw user text to the shell.
 */

const PACKAGE_RE = /^[A-Za-z0-9][A-Za-z0-9.+_-]*$/;
const USERNAME_RE = /^[a-z_][a-z0-9_-]*\$?$/;
const GROUP_RE = /^[a-z_][a-z0-9_-]*$/;
const DOMAIN_RE =
  /^(\*\.)?(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
const PROVIDER_RE = /^[a-z0-9_]+$/;

export function isValidPid(pid: unknown): pid is number {
  const n = typeof pid === "string" ? Number(pid) : pid;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 2 ** 31;
}

export function isValidPort(port: unknown): port is number {
  const n = typeof port === "string" ? Number(port) : port;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
}

export function isValidPackageName(pkg: unknown): pkg is string {
  return typeof pkg === "string" && pkg.length <= 128 && PACKAGE_RE.test(pkg);
}

export function isValidUsername(name: unknown): name is string {
  return (
    typeof name === "string" && name.length <= 32 && USERNAME_RE.test(name)
  );
}

export function isValidGroupName(name: unknown): name is string {
  return typeof name === "string" && name.length <= 32 && GROUP_RE.test(name);
}

export function isValidDomain(domain: unknown): domain is string {
  return (
    typeof domain === "string" && domain.length <= 253 && DOMAIN_RE.test(domain)
  );
}

export function isValidDnsProvider(provider: unknown): provider is string {
  return (
    typeof provider === "string" &&
    provider.length <= 64 &&
    PROVIDER_RE.test(provider)
  );
}

export type Signal = "TERM" | "KILL" | "HUP" | "INT";
const SIGNALS: Signal[] = ["TERM", "KILL", "HUP", "INT"];
export function isValidSignal(sig: unknown): sig is Signal {
  return typeof sig === "string" && (SIGNALS as string[]).includes(sig);
}

export type IpProtocol = "tcp" | "udp";
export function isValidIpProtocol(p: unknown): p is IpProtocol {
  return p === "tcp" || p === "udp";
}

export type FirewallTarget = "ACCEPT" | "DROP" | "REJECT";
const FW_TARGETS: FirewallTarget[] = ["ACCEPT", "DROP", "REJECT"];
export function isValidFirewallTarget(t: unknown): t is FirewallTarget {
  return typeof t === "string" && (FW_TARGETS as string[]).includes(t);
}

type TailscaleAction = "up" | "down";
const TAILSCALE_ACTIONS: TailscaleAction[] = ["up", "down"];
function isValidTailscaleAction(a: unknown): a is TailscaleAction {
  return typeof a === "string" && (TAILSCALE_ACTIONS as string[]).includes(a);
}

/**
 * Validate an absolute file path against an allowlist of permitted prefixes and
 * reject traversal.
 */
export function isAllowedPath(
  path: unknown,
  allowedPrefixes: string[],
): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    return false;
  }
  if (!path.startsWith("/")) return false;
  if (path.includes("\0")) return false;
  if (path.split("/").some((seg) => seg === "..")) return false;
  return allowedPrefixes.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`),
  );
}
