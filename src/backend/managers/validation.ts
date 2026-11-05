/**
 * Strict allowlist validators for every dynamic value that reaches a shell
 * command. Managers MUST validate inputs through these before interpolation;
 * never pass raw user text to the shell.
 */

export function isValidPort(port: unknown): port is number {
  const n = typeof port === "string" ? Number(port) : port;
  return typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;
}
