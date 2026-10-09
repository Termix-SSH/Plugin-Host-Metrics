import {
  execCommand,
  shellSingleQuote,
} from "@termix-ssh/plugin-sdk/host-commands";
import { isValidPort } from "./validation.js";
import type { Router } from "express";
import type { Client } from "ssh2";
import { managerHandler, ManagerInputError } from "./route-helpers.js";
import type { HealthCheckEvent, ManagerRoutesDeps } from "./types.js";
import type { HostMetricsRepository } from "../repository.js";

export interface HealthCheck {
  id: string;
  name: string;
  type: "tcp" | "http";
  target: string;
  port?: number;
  path?: string;
}

export interface HealthResult {
  checkId: string;
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}

const TARGET_RE = /^[A-Za-z0-9.\-_:]+$/;
const PATH_RE = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/%-]*$/;

function isValidHealthCheck(c: unknown): c is HealthCheck {
  if (!c || typeof c !== "object") return false;
  const o = c as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return false;
  if (typeof o.name !== "string") return false;
  if (o.type !== "tcp" && o.type !== "http") return false;
  if (typeof o.target !== "string" || !TARGET_RE.test(o.target)) return false;
  if (o.type === "tcp" && !isValidPort(o.port)) return false;
  if (
    o.path !== undefined &&
    (typeof o.path !== "string" || !PATH_RE.test(o.path))
  )
    return false;
  return true;
}

/** Build a command that runs the check from the host and prints "ok latency". */
export function buildHealthCheckCommand(check: HealthCheck): string {
  if (check.type === "tcp") {
    const host = shellSingleQuote(check.target);
    const port = check.port;
    // Prefer bash /dev/tcp; time it with date in ms.
    return `start=$(date +%s%3N); if timeout 3 bash -c '</dev/tcp/'${host}'/'${port} 2>/dev/null; then echo "ok $(( $(date +%s%3N) - start ))"; else echo "fail $(( $(date +%s%3N) - start ))"; fi`;
  }
  // http
  const scheme = check.target.includes("://") ? "" : "http://";
  const url = shellSingleQuote(`${scheme}${check.target}${check.path ?? ""}`);
  return `curl -s -o /dev/null -m 5 -w '%{http_code} %{time_total}' ${url} || echo '000 0'`;
}

export function parseHealthResult(
  check: HealthCheck,
  output: string,
): HealthResult {
  const line = output.trim().split("\n").pop() ?? "";
  if (check.type === "tcp") {
    const [status, ms] = line.split(/\s+/);
    return {
      checkId: check.id,
      ok: status === "ok",
      latencyMs: Number(ms) || null,
      detail: status === "ok" ? "open" : "closed/timeout",
    };
  }
  const m = line.match(/^(\d{3})\s+([\d.]+)/);
  if (!m)
    return { checkId: check.id, ok: false, latencyMs: null, detail: line };
  const code = Number(m[1]);
  return {
    checkId: check.id,
    ok: code >= 200 && code < 400,
    latencyMs: Math.round(Number(m[2]) * 1000),
    detail: `HTTP ${code}`,
  };
}

export async function runChecks(
  client: Client,
  checks: HealthCheck[],
): Promise<HealthResult[]> {
  return Promise.all(
    checks.map(async (check) => {
      try {
        const { stdout } = await execCommand(
          client,
          buildHealthCheckCommand(check),
          8000,
        );
        return parseHealthResult(check, stdout);
      } catch {
        return {
          checkId: check.id,
          ok: false,
          latencyMs: null,
          detail: "error",
        };
      }
    }),
  );
}

const HISTORY_KEEP = 500;

/** Saved interval bounds, in seconds. The scheduler never runs faster than the minimum. */
export const MIN_HEALTH_INTERVAL = 30;
export const MAX_HEALTH_INTERVAL = 86400;
export const DEFAULT_HEALTH_INTERVAL = 300;

/** The valid checks in a saved JSON array. */
export function parseChecks(json: string | null | undefined): HealthCheck[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(isValidHealthCheck) : [];
  } catch {
    return [];
  }
}

async function loadChecks(
  repository: HostMetricsRepository,
  userId: string,
  hostId: number,
): Promise<{ checks: HealthCheck[]; intervalSeconds: number }> {
  const row = await repository.findChecks(userId, hostId);
  return {
    checks: parseChecks(row?.checks),
    intervalSeconds: row?.intervalSeconds || DEFAULT_HEALTH_INTERVAL,
  };
}

/** A check that went from passing to failing, or back. */
export interface HealthChange {
  userId: string;
  hostId: number;
  check: HealthCheck;
  result: HealthResult;
}

/** Stores results, emits the health check event and reports flips. */
export type HealthRecorder = (
  userId: string,
  hostId: number,
  checks: HealthCheck[],
  results: HealthResult[],
) => Promise<void>;

export function createHealthRecorder(deps: {
  repository: HostMetricsRepository;
  onHealthCheck: (event: HealthCheckEvent) => void;
  onChange?: (change: HealthChange) => Promise<void>;
}): HealthRecorder {
  const { repository } = deps;
  return async (userId, hostId, checks, results) => {
    if (!results.length) return;
    const previous = new Map<string, boolean>();
    if (deps.onChange) {
      for (const row of await repository.listHealth(userId, hostId, 200)) {
        if (!previous.has(row.checkId)) previous.set(row.checkId, row.ok);
      }
    }
    await repository.recordHealth(userId, hostId, results, HISTORY_KEEP);
    for (const result of results) {
      deps.onHealthCheck({
        hostId,
        userId,
        checkId: result.checkId,
        ok: result.ok,
        detail: result.detail ?? undefined,
      });
      const before = previous.get(result.checkId);
      const check = checks.find((c) => c.id === result.checkId);
      if (
        deps.onChange &&
        check &&
        before !== undefined &&
        before !== result.ok
      ) {
        await deps.onChange({ userId, hostId, check, result });
      }
    }
  };
}

export function registerHealthRoutes(
  app: Router,
  deps: ManagerRoutesDeps,
): void {
  const { validateHostId, repository, recordHealth } = deps;

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/health/{id}:
   *   get:
   *     summary: Get the host's health checks and their last results
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: The configured checks, their interval and results. }
   *       400: { description: Invalid input. }
   *       403: { description: No access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.get(
    "/host-metrics/managers/health/:id",
    validateHostId,
    managerHandler(deps, "connect", "health_get", async (client, host) => {
      const userId = host.actorId;
      const { checks, intervalSeconds } = await loadChecks(
        repository,
        userId,
        host.id,
      );
      const results = checks.length ? await runChecks(client, checks) : [];
      await recordHealth(userId, host.id, checks, results);
      const history = await repository.listHealth(userId, host.id, 200);
      return { checks, intervalSeconds, results, history };
    }),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/health/{id}/config:
   *   post:
   *     summary: Save the host's health checks
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
   *             required: [checks]
   *             properties:
   *               checks: { type: array, items: { type: object, properties: { id: { type: string }, name: { type: string }, type: { type: string }, target: { type: string }, port: { type: integer }, path: { type: string } } } }
   *               intervalSeconds: { type: integer }
   *     responses:
   *       200: { description: The saved checks. }
   *       400: { description: Invalid input. }
   *       403: { description: No access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.post(
    "/host-metrics/managers/health/:id/config",
    validateHostId,
    managerHandler(
      deps,
      "connect",
      "health_config",
      async (_client, host, req) => {
        const userId = host.actorId;
        const { checks, intervalSeconds } = req.body as {
          checks?: unknown;
          intervalSeconds?: number;
        };
        if (!Array.isArray(checks) || !checks.every(isValidHealthCheck)) {
          throw new ManagerInputError("Invalid checks");
        }
        const interval =
          typeof intervalSeconds === "number" &&
          intervalSeconds >= MIN_HEALTH_INTERVAL &&
          intervalSeconds <= MAX_HEALTH_INTERVAL
            ? Math.round(intervalSeconds)
            : DEFAULT_HEALTH_INTERVAL;
        await repository.saveChecks(
          userId,
          host.id,
          JSON.stringify(checks),
          interval,
        );
        return { success: true };
      },
    ),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/health/{id}/run:
   *   post:
   *     summary: Run the host's health checks now
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: The result of each check. }
   *       400: { description: Invalid input. }
   *       403: { description: No access to the host, or elevation denied. }
   *       500: { description: The command failed on the host. }
   */
  app.post(
    "/host-metrics/managers/health/:id/run",
    validateHostId,
    managerHandler(deps, "connect", "health_run", async (client, host) => {
      const { checks } = await loadChecks(repository, host.actorId, host.id);
      const results = await runChecks(client, checks);
      await recordHealth(host.actorId, host.id, checks, results);
      return { results };
    }),
  );
}
