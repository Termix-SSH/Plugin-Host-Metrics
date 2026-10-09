import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import {
  MANAGER_CONNECTION,
  supportsMetrics,
  type MetricsHost,
} from "./helpers.js";
import type { MetricsLogger } from "./log.js";
import {
  DEFAULT_HEALTH_INTERVAL,
  MIN_HEALTH_INTERVAL,
  parseChecks,
  runChecks,
  type HealthChange,
  type HealthRecorder,
} from "./managers/health.js";
import type { HostMetricsRepository } from "./repository.js";
import { ConcurrentLimiter, metricsConcurrencyFor } from "./state.js";

/** How often the scheduler looks for checks that are due. */
export const HEALTH_TICK_MS = 15_000;
/** The first run after boot or a new save is spread over up to this long. */
const FIRST_RUN_SPREAD_MS = 60_000;

export interface HealthSchedulerDeps {
  ctx: Pick<PluginContext, "asUser" | "hosts" | "ssh" | "schedule">;
  repository: Pick<HostMetricsRepository, "listAllChecks" | "findChecks">;
  poller: {
    resolve: (hostId: number, userId: string) => Promise<MetricsHost | null>;
    settingsFor: (hostId: number) => Promise<{ metricsEnabled: boolean }>;
  };
  record: HealthRecorder;
  log: MetricsLogger;
  random?: () => number;
}

/**
 * Runs every saved set of health checks on its interval, as the user who
 * saved it. One loop picks the due ones; a set never runs twice at once.
 */
export class HealthScheduler {
  private readonly nextRun = new Map<string, number>();
  private readonly running = new Set<string>();
  private readonly inflight = new Set<Promise<void>>();
  private readonly limiter = new ConcurrentLimiter(metricsConcurrencyFor(0));
  private stopTick: (() => void) | null = null;
  private disposed = false;

  constructor(private readonly deps: HealthSchedulerDeps) {}

  start(): void {
    this.stopTick = this.deps.ctx.schedule.every(HEALTH_TICK_MS, () =>
      this.tick(),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.stopTick?.();
    this.stopTick = null;
    this.nextRun.clear();
  }

  /** Resolves once every run started so far has finished. */
  async drain(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  async tick(): Promise<void> {
    if (this.disposed) return;
    let rows;
    try {
      rows = await this.deps.repository.listAllChecks();
    } catch (error) {
      this.deps.log.warn("Could not load health checks", {
        operation: "health_schedule_load",
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.disposed) return;

    const now = Date.now();
    const random = this.deps.random ?? Math.random;
    const seen = new Set<string>();
    const due: Array<{ key: string; userId: string; hostId: number }> = [];
    for (const row of rows) {
      const checks = parseChecks(row.checks);
      if (!checks.length) continue;
      const key = `${row.userId}:${row.hostId}`;
      seen.add(key);
      const intervalMs = intervalMsOf(row.intervalSeconds);
      let at = this.nextRun.get(key);
      if (at === undefined) {
        at =
          now +
          Math.floor(random() * Math.min(intervalMs, FIRST_RUN_SPREAD_MS));
      }
      // A shorter interval saved since the last run takes effect now.
      at = Math.min(at, now + intervalMs);
      this.nextRun.set(key, at);
      if (at > now || this.running.has(key)) continue;
      due.push({ key, userId: row.userId, hostId: row.hostId });
    }
    for (const key of [...this.nextRun.keys()]) {
      if (!seen.has(key)) this.nextRun.delete(key);
    }

    this.limiter.setLimit(metricsConcurrencyFor(seen.size));
    for (const job of due) {
      this.running.add(job.key);
      const run = this.limiter
        .run(() => this.runOne(job.userId, job.hostId))
        .finally(() => {
          this.running.delete(job.key);
          this.inflight.delete(run);
          if (!this.disposed && this.nextRun.has(job.key)) {
            const row = rows.find(
              (r) => r.userId === job.userId && r.hostId === job.hostId,
            );
            this.nextRun.set(
              job.key,
              Date.now() + intervalMsOf(row?.intervalSeconds),
            );
          }
        });
      this.inflight.add(run);
    }
  }

  private async runOne(userId: string, hostId: number): Promise<void> {
    if (this.disposed) return;
    const { ctx, poller, repository, record, log } = this.deps;
    try {
      await ctx.asUser(userId, async () => {
        const access = await ctx.hosts.checkAccess(hostId, "connect");
        if (!access.hasAccess) return;
        const host = await poller.resolve(hostId, userId);
        if (!host || !supportsMetrics(host, ctx.ssh)) return;
        if (!(await poller.settingsFor(hostId)).metricsEnabled) return;
        // Read again so a save during the wait is what runs.
        const row = await repository.findChecks(userId, hostId);
        const checks = parseChecks(row?.checks);
        if (!checks.length || this.disposed) return;
        const results = await ctx.ssh.withConnection(
          host,
          MANAGER_CONNECTION,
          (client) => runChecks(client as never, checks),
        );
        if (this.disposed) return;
        await record(userId, hostId, checks, results);
      });
    } catch (error) {
      log.warn("Scheduled health checks failed", {
        operation: "health_schedule_run",
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function intervalMsOf(seconds: number | undefined): number {
  const value = Number(seconds) || DEFAULT_HEALTH_INTERVAL;
  return Math.max(MIN_HEALTH_INTERVAL, value) * 1000;
}

/** Sends the check's owner an alert when a check starts failing or recovers. */
export function createHealthAlerts(
  ctx: Pick<PluginContext, "asUser" | "hosts" | "notify">,
  log: MetricsLogger,
): (change: HealthChange) => Promise<void> {
  return async ({ userId, hostId, check, result }) => {
    try {
      const host = await ctx
        .asUser(userId, () => ctx.hosts.get(hostId))
        .catch(() => null);
      const hostName = host?.name || host?.ip || `#${hostId}`;
      const name = check.name || check.target;
      await ctx.notify.send(
        result.ok
          ? {
              title: `${name} is back up on ${hostName}`,
              body: result.detail || undefined,
              severity: "success",
              category: "host-metrics.health_recovered",
              audience: { userId },
              link: { tab: "host-metrics" },
              dedupeKey: `host-metrics:health:${hostId}:${check.id}:up`,
              context: { hostId, hostName },
            }
          : {
              title: `${name} is failing on ${hostName}`,
              body: result.detail || undefined,
              severity: "warning",
              category: "host-metrics.health_failed",
              audience: { userId },
              link: { tab: "host-metrics" },
              dedupeKey: `host-metrics:health:${hostId}:${check.id}:down`,
              context: { hostId, hostName },
            },
      );
    } catch (error) {
      log.warn("Could not send a health check alert", {
        operation: "health_alert",
        hostId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
}
