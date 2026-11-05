/**
 * Strict allowlist validators for every dynamic value that reaches a shell
 * command. Managers MUST validate inputs through these before interpolation;
 * never pass raw user text to the shell.
 */

export function isValidPid(pid: unknown): pid is number {
  const n = typeof pid === "string" ? Number(pid) : pid;
  return typeof n === "number" && Number.isInteger(n) && n > 0 && n < 2 ** 31;
}

export function isValidPort(port: unknown): port is number {
  const n = typeof port === "string" ? Number(port) : port;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
}

export type Signal = "TERM" | "KILL" | "HUP" | "INT";
const SIGNALS: Signal[] = ["TERM", "KILL", "HUP", "INT"];
export function isValidSignal(sig: unknown): sig is Signal {
  return typeof sig === "string" && (SIGNALS as string[]).includes(sig);
}
