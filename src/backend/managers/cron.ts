import {
  execCommand,
  shellSingleQuote,
} from "@termix-ssh/plugin-sdk/host-commands";
import type { Router } from "express";
import { managerHandler, ManagerInputError } from "./route-helpers.js";
import type { ManagerRoutesDeps } from "./types.js";

export interface CronEntry {
  raw: string;
  enabled: boolean;
  schedule: string;
  command: string;
}

const READ_CRONTAB_CMD = "crontab -l 2>/dev/null";

/** The job on one crontab line, or null for comments, variables and blanks. */
function parseCrontabLine(raw: string): CronEntry | null {
  const line = raw.replace(/\s+$/, "");
  if (!line.trim()) return null;
  // A commented-out job: "# <schedule> <command>" (our toggle convention).
  const disabled = line.match(
    /^#\s*((?:@\w+|\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+.+)$/,
  );
  if (disabled) {
    const { schedule, command } = splitScheduleCommand(disabled[1]);
    if (command && isValidCronSchedule(schedule)) {
      return { raw: line, enabled: false, schedule, command };
    }
  }
  if (line.trimStart().startsWith("#")) return null;
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return null;
  const { schedule, command } = splitScheduleCommand(line.trim());
  if (!command) return null;
  return { raw: line, enabled: true, schedule, command };
}

/** Parse a crontab into entries (comments/blank lines are dropped except as toggles). */
export function parseCrontab(output: string): CronEntry[] {
  return output
    .split("\n")
    .map(parseCrontabLine)
    .filter((entry): entry is CronEntry => entry !== null);
}

/** Variables and plain comments, kept when the jobs are rewritten. */
export function crontabPreamble(output: string): string {
  const kept = output
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line) => line.trim() && parseCrontabLine(line) === null);
  return kept.length ? kept.join("\n") + "\n" : "";
}

function splitScheduleCommand(line: string): {
  schedule: string;
  command: string;
} {
  if (line.startsWith("@")) {
    const [sched, ...rest] = line.split(/\s+/);
    return { schedule: sched, command: rest.join(" ") };
  }
  const parts = line.split(/\s+/);
  if (parts.length < 6) return { schedule: "", command: "" };
  return {
    schedule: parts.slice(0, 5).join(" "),
    command: parts.slice(5).join(" "),
  };
}

const CRON_SCHEDULE_RE =
  /^(@(reboot|yearly|annually|monthly|weekly|daily|midnight|hourly)|[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,-]+\s+[\d*/,A-Za-z-]+\s+[\d*/,A-Za-z-]+)$/;

export function isValidCronSchedule(schedule: string): boolean {
  return CRON_SCHEDULE_RE.test(schedule.trim());
}

/** Serialize entries into a full crontab body (toggled entries are commented). */
export function serializeCrontab(entries: CronEntry[]): string {
  const lines = entries.map((e) => {
    const body = `${e.schedule} ${e.command}`.trim();
    return e.enabled ? body : `# ${body}`;
  });
  return lines.join("\n") + (lines.length ? "\n" : "");
}

/** Build a command that atomically replaces the user crontab from the given body. */
export function buildApplyCrontabCommand(body: string): string {
  // printf the exact bytes into `crontab -` (reads new crontab from stdin).
  return `printf '%s' ${shellSingleQuote(body)} | crontab -`;
}

export function registerCronRoutes(app: Router, deps: ManagerRoutesDeps): void {
  const { validateHostId } = deps;
  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/cron/{id}:
   *   get:
   *     summary: List the SSH user's crontab entries
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: The parsed crontab entries. }
   *       400: { description: Invalid input. }
   *       403: { description: No access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.get(
    "/host-metrics/managers/cron/:id",
    validateHostId,
    managerHandler(deps, "connect", "cron_list", async (client) => {
      const { stdout } = await execCommand(client, READ_CRONTAB_CMD, 15000);
      return { entries: parseCrontab(stdout) };
    }),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/cron/{id}:
   *   post:
   *     summary: Replace the SSH user's crontab
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [entries]
   *             properties:
   *               entries: { type: array, items: { type: object, properties: { schedule: { type: string }, command: { type: string }, enabled: { type: boolean } } } }
   *     responses:
   *       200: { description: The crontab was written. }
   *       400: { description: Invalid input. }
   *       403: { description: No access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.post(
    "/host-metrics/managers/cron/:id",
    validateHostId,
    managerHandler(
      deps,
      "connect",
      "cron_replace",
      async (client, _host, req) => {
        const { entries } = (req.body ?? {}) as { entries?: CronEntry[] };
        if (!Array.isArray(entries)) {
          throw new ManagerInputError("entries must be an array");
        }
        for (const e of entries) {
          if (typeof e?.command !== "string" || !e.command.trim()) {
            throw new ManagerInputError("Each entry needs a command");
          }
          if (/[\r\n]/.test(e.command)) {
            throw new ManagerInputError("Commands cannot contain newlines");
          }
          if (!isValidCronSchedule(String(e.schedule))) {
            throw new ManagerInputError(`Invalid schedule: ${e.schedule}`);
          }
        }
        const current = await execCommand(client, READ_CRONTAB_CMD, 15000);
        const body =
          crontabPreamble(current.stdout) + serializeCrontab(entries);
        const { stdout, stderr, code } = await execCommand(
          client,
          buildApplyCrontabCommand(body),
          15000,
        );
        return { success: code === 0, output: stdout || stderr };
      },
    ),
  );
}
