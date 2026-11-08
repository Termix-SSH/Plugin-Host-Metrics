import type { Request, Response, Router } from "express";
import type { PluginHostSummary } from "@termix-ssh/plugin-sdk/backend";
import {
  deriveEnabledWidgets,
  sanitizeLayout,
} from "../shared/host-metrics.js";
import {
  MAX_TEMPLATE_HOSTS,
  MAX_TEMPLATES,
  templateLayout,
} from "../shared/layout-templates.js";
import {
  DEFAULT_HEALTH_INTERVAL,
  MAX_HEALTH_INTERVAL,
  MIN_HEALTH_INTERVAL,
  parseChecks,
} from "./managers/health.js";
import {
  sqlTimestamp,
  type HealthHistoryRow,
  type MetricsHistoryRow,
} from "./repository.js";
import type { RouteDeps } from "./routes.js";

export const EXPORT_SCHEMA = 1;
const MAX_HISTORY_ROWS = 50_000;
const MAX_HEALTH_ROWS = 5_000;

interface HostMatch {
  name: string | null;
  ip: string;
  port: number;
  username: string;
}

interface ExportHost {
  match: HostMatch;
  layout?: unknown;
  checks?: unknown[];
  intervalSeconds?: number;
  history?: { metrics?: unknown[]; health?: unknown[] };
}

export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

const matchOf = (host: PluginHostSummary): HostMatch => ({
  name: host.name,
  ip: host.ip,
  port: host.port,
  username: host.username,
});

const sameAddress = (a: HostMatch, b: HostMatch) =>
  a.ip === b.ip && a.port === b.port && a.username === b.username;

const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function parseTs(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(
    value.includes("T") ? value : `${value.replace(" ", "T")}Z`,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

function metricRow(raw: unknown): MetricsHistoryRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const ts = parseTs(row.ts);
  if (!ts) return null;
  return {
    ts: sqlTimestamp(ts),
    cpuPercent: num(row.cpuPercent),
    memPercent: num(row.memPercent),
    diskPercent: num(row.diskPercent),
    netRxBytes: num(row.netRxBytes),
    netTxBytes: num(row.netTxBytes),
  };
}

function healthRow(raw: unknown): HealthHistoryRow | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const ts = parseTs(row.ts);
  if (!ts || typeof row.checkId !== "string" || row.checkId.length > 128)
    return null;
  return {
    checkId: row.checkId,
    ts: sqlTimestamp(ts),
    ok: row.ok === true,
    latencyMs: num(row.latencyMs),
    detail: typeof row.detail === "string" ? row.detail.slice(0, 2000) : null,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Export and import of the acting user's layouts, checks, templates and history. */
export function registerTransferRoutes(router: Router, deps: RouteDeps): void {
  const { ctx, repository, log } = deps;

  const userOf = (res: Response): string | null => {
    const userId = ctx.currentActor();
    if (!userId) res.status(401).json({ error: "Authentication required" });
    return userId ?? null;
  };

  /**
   * @openapi
   * /plugin-api/host-metrics/export:
   *   get:
   *     summary: Export layouts, health checks, templates and history
   *     description: Downloads the acting user's Host Metrics data as JSON. Hosts are matched on import by address, port and user, so the file moves between servers. Only hosts the caller can connect to are included.
   *     tags:
   *       - Host Metrics
   *     parameters:
   *       - in: query
   *         name: history
   *         schema:
   *           type: boolean
   *         description: Include metric samples and health results.
   *       - in: query
   *         name: from
   *         schema:
   *           type: string
   *         description: Start of the history range (ISO date). Defaults to 30 days before the end.
   *       - in: query
   *         name: to
   *         schema:
   *           type: string
   *         description: End of the history range (ISO date). Defaults to now.
   *       - in: query
   *         name: hostIds
   *         schema:
   *           type: string
   *         description: Comma separated host ids. Defaults to every host with data.
   *     responses:
   *       200:
   *         description: A JSON file.
   *       400:
   *         description: Invalid date range.
   */
  router.get("/export", async (req: Request, res: Response) => {
    const userId = userOf(res);
    if (!userId) return;
    try {
      const q = req.query as Record<string, string | undefined>;
      const withHistory = q.history === "1" || q.history === "true";
      const to = q.to ? new Date(q.to) : new Date();
      const from = q.from
        ? new Date(q.from)
        : new Date(to.getTime() - 30 * 86_400_000);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
        return res.status(400).json({ error: "Invalid from/to date format" });
      const only = q.hostIds
        ? new Set(
            q.hostIds
              .split(",")
              .map(Number)
              .filter((n) => Number.isInteger(n) && n > 0),
          )
        : null;

      const hosts = new Map<number, PluginHostSummary>();
      for (const host of await ctx.hosts.list()) hosts.set(host.id, host);
      const layouts = new Map(
        (await repository.listUserLayouts(userId)).map((r) => [
          r.hostId,
          r.layout,
        ]),
      );
      const checks = new Map(
        (await repository.listUserChecks(userId)).map((r) => [r.hostId, r]),
      );
      const ids = new Set<number>([...layouts.keys(), ...checks.keys()]);
      if (withHistory) for (const id of hosts.keys()) ids.add(id);

      const out: ExportHost[] = [];
      let budget = MAX_HISTORY_ROWS;
      for (const hostId of [...ids].sort((a, b) => a - b)) {
        const host = hosts.get(hostId);
        if (!host || (only && !only.has(hostId))) continue;
        if (!(await ctx.hosts.checkAccess(hostId, "connect")).hasAccess)
          continue;
        const entry: ExportHost = { match: matchOf(host) };
        const layout = layouts.get(hostId);
        if (layout)
          entry.layout = sanitizeLayout(safeJson(layout)) ?? undefined;
        const row = checks.get(hostId);
        if (row) {
          entry.checks = parseChecks(row.checks);
          entry.intervalSeconds =
            row.intervalSeconds || DEFAULT_HEALTH_INTERVAL;
        }
        if (withHistory) {
          const samples = (
            await repository.listSamples(
              hostId,
              sqlTimestamp(from),
              sqlTimestamp(to),
            )
          ).slice(0, Math.max(budget, 0));
          budget -= samples.length;
          const results = (
            await repository.listHealth(userId, hostId, MAX_HEALTH_ROWS)
          )
            .filter((r) => {
              const t = parseTs(r.ts);
              return t && t >= from && t <= to;
            })
            .reverse();
          if (samples.length || results.length)
            entry.history = { metrics: samples, health: results };
        }
        if (entry.layout || entry.checks || entry.history) out.push(entry);
      }
      const templates = (await repository.listTemplates(userId)).flatMap(
        (row) => {
          const layout = templateLayout(safeJson(row.layout));
          return layout ? [{ name: row.name, layout }] : [];
        },
      );

      await ctx.audit.record({
        action: "export_host_metrics",
        resourceType: "host-metrics",
        details: JSON.stringify({
          hosts: out.length,
          templates: templates.length,
          history: withHistory,
        }),
        success: true,
        request: req,
      });
      const name = `host-metrics-${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.send(
        JSON.stringify({
          plugin: "host-metrics",
          schema: EXPORT_SCHEMA,
          exportedAt: new Date().toISOString(),
          hosts: out,
          templates,
        }),
      );
    } catch (error) {
      log.error("Host Metrics export failed", error, { operation: "export" });
      res.status(500).json({ error: "Export failed" });
    }
  });

  /**
   * @openapi
   * /plugin-api/host-metrics/import:
   *   post:
   *     summary: Import layouts, health checks, templates and history
   *     description: Reads a file made by the export route. Each host is matched by address, port and user among the hosts the caller can connect to; others are skipped. Existing layouts, checks and templates are kept unless overwrite is true. History rows already stored are never duplicated.
   *     tags:
   *       - Host Metrics
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [data]
   *             properties:
   *               data:
   *                 type: object
   *                 description: The exported file.
   *               overwrite:
   *                 type: boolean
   *               history:
   *                 type: boolean
   *                 description: Also import history rows. Defaults to true.
   *     responses:
   *       200:
   *         description: Counts of imported, updated, skipped and failed items.
   *       400:
   *         description: Not a Host Metrics export, or too large.
   */
  router.post("/import", async (req: Request, res: Response) => {
    const userId = userOf(res);
    if (!userId) return;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | undefined;
    const overwrite = body.overwrite === true;
    const withHistory = body.history !== false;
    if (
      !data ||
      typeof data !== "object" ||
      data.plugin !== "host-metrics" ||
      data.schema !== EXPORT_SCHEMA ||
      !Array.isArray(data.hosts) ||
      data.hosts.length > MAX_TEMPLATE_HOSTS ||
      (data.templates !== undefined &&
        (!Array.isArray(data.templates) ||
          data.templates.length > MAX_TEMPLATES))
    )
      return res.status(400).json({ error: "Not a valid Host Metrics export" });

    const result: ImportResult = {
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };
    const fail = (message: string) => {
      result.failed++;
      if (result.errors.length < 50) result.errors.push(message);
    };
    try {
      const local = await ctx.hosts.list();
      for (const raw of data.hosts as ExportHost[]) {
        const m = raw?.match;
        const label = m
          ? `${m.username ?? ""}@${m.ip ?? ""}:${m.port ?? ""}`
          : "?";
        if (
          !m ||
          typeof m.ip !== "string" ||
          typeof m.username !== "string" ||
          !Number.isInteger(m.port)
        ) {
          fail(`Invalid host entry ${label}`);
          continue;
        }
        const candidates = local.filter((h) => sameAddress(matchOf(h), m));
        const host =
          candidates.find((h) => h.name === m.name) ?? candidates[0] ?? null;
        if (!host) {
          result.skipped++;
          continue;
        }
        const access = await ctx.hosts.checkAccess(host.id, "connect");
        if (!access.hasAccess) {
          result.skipped++;
          continue;
        }
        try {
          if (raw.layout !== undefined) {
            const layout = templateLayout(raw.layout);
            const had = await repository.findLayout(userId, host.id);
            if (!layout) fail(`Invalid layout for ${label}`);
            else if (overwrite || !had) {
              await repository.saveLayout(
                userId,
                host.id,
                JSON.stringify(layout),
              );
              if (access.isOwner)
                await ctx.settings.setHost(
                  host.id,
                  "enabledWidgets",
                  deriveEnabledWidgets(layout.slots),
                );
              if (had) result.updated++;
              else result.imported++;
            }
          }
          if (Array.isArray(raw.checks)) {
            const checks = parseChecks(JSON.stringify(raw.checks));
            const interval = Number(raw.intervalSeconds);
            const seconds =
              Number.isInteger(interval) &&
              interval >= MIN_HEALTH_INTERVAL &&
              interval <= MAX_HEALTH_INTERVAL
                ? interval
                : DEFAULT_HEALTH_INTERVAL;
            const had = await repository.findChecks(userId, host.id);
            if (checks.length !== raw.checks.length)
              fail(`Invalid checks for ${label}`);
            else if (overwrite || !had) {
              await repository.saveChecks(
                userId,
                host.id,
                JSON.stringify(checks),
                seconds,
              );
              if (had) result.updated++;
              else result.imported++;
            }
          }
          if (withHistory && raw.history) {
            const metrics = (
              Array.isArray(raw.history.metrics) ? raw.history.metrics : []
            )
              .slice(0, MAX_HISTORY_ROWS)
              .flatMap((r) => metricRow(r) ?? []);
            const results = (
              Array.isArray(raw.history.health) ? raw.history.health : []
            )
              .slice(0, MAX_HEALTH_ROWS)
              .flatMap((r) => healthRow(r) ?? []);
            // Metric samples are shared by everyone who can see the host.
            if (
              metrics.length &&
              (await ctx.hosts.checkAccess(host.id, "edit")).hasAccess
            )
              result.imported += await repository.importSamples(
                host.id,
                metrics,
              );
            result.imported += await repository.importHealth(
              userId,
              host.id,
              results,
            );
          }
        } catch (error) {
          log.error("Host Metrics import failed for a host", error, {
            operation: "import",
            hostId: host.id,
          });
          fail(`Could not import ${label}`);
        }
      }

      const existing = new Set(
        (await repository.listTemplates(userId)).map((t) => t.name),
      );
      for (const item of (data.templates ?? []) as Array<{
        name?: unknown;
        layout?: unknown;
      }>) {
        const layout = templateLayout(item?.layout);
        const name = typeof item?.name === "string" ? item.name.trim() : "";
        if (!layout || !name || name.length > 100) {
          fail("Invalid template");
          continue;
        }
        if (existing.has(name) && !overwrite) {
          result.skipped++;
          continue;
        }
        if (existing.has(name)) {
          const old = (await repository.listTemplates(userId)).find(
            (t) => t.name === name,
          );
          if (old) await repository.deleteTemplate(userId, old.id);
        }
        const row = await repository.createTemplate(userId, {
          name,
          layout: JSON.stringify(layout),
        });
        if (!row) fail(`Too many templates, skipped ${name}`);
        else {
          existing.add(name);
          result.imported++;
        }
      }
      await ctx.audit.record({
        action: "import_host_metrics",
        resourceType: "host-metrics",
        details: JSON.stringify({ ...result, errors: result.errors.length }),
        success: result.failed === 0,
        request: req,
      });
      res.json(result);
    } catch (error) {
      log.error("Host Metrics import failed", error, { operation: "import" });
      res.status(500).json({ error: "Import failed" });
    }
  });
}
