import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableName,
  gte,
  lt,
  lte,
  notInArray,
} from "drizzle-orm";
import { int, longtext, mysqlTable, varchar } from "drizzle-orm/mysql-core";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";
import { KEY_LENGTH } from "@termix-ssh/plugin-sdk/db";
import { MAX_TEMPLATES } from "../shared/layout-templates.js";
import {
  hostHealthChecks,
  hostHealthHistory,
  hostMetricsHistory,
  hostMetricsPreferences,
  layoutTemplates,
} from "./tables.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
// ctx.db.define hands tables back untyped, and the drizzle handle is the
// server's own. Typed at this module's edge instead.
type Table = any;
type Drizzle = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface HealthResultInput {
  checkId: string;
  ok: boolean;
  latencyMs: number | null;
  detail: string;
}

export interface HealthHistoryRow {
  checkId: string;
  ts: string;
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
}

export interface HealthChecksRow {
  userId: string;
  hostId: number;
  checks: string;
  intervalSeconds: number;
}

export interface LayoutTemplateRow {
  id: number;
  name: string;
  layout: string;
}

export interface MetricsHistoryInput {
  hostId: number;
  cpuPercent: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

export interface MetricsHistoryRow {
  ts: string;
  cpuPercent: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
}

/** Timestamps are text in `YYYY-MM-DD HH:MM:SS` UTC, which sorts in time order. */
export function sqlTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

export type HostMetricsRepository = Awaited<
  ReturnType<typeof createHostMetricsRepository>
>;

/**
 * Config upserts read the row by its unique (user, host) pair first.
 */
const SAMPLE_GAP_MS = 55_000;
const PRUNE_GAP_MS = 10 * 60_000;
const HISTORY_PERSIST_GAP_MS = 5 * 60_000;

export async function createHostMetricsRepository(db: PluginDatabase) {
  const sampleTimes = new Map<number, { written: number; pruned: number }>();
  let lastHistoryPersist = 0;
  const preferences: Table = await db.define(hostMetricsPreferences);
  const checks: Table = await db.define(hostHealthChecks);
  const health: Table = await db.define(hostHealthHistory);
  const history: Table = await db.define(hostMetricsHistory);
  const definedTemplates: Table = await db.define(layoutTemplates);
  // The SDK returns sqlite-core tables; MySQL $returningId needs native autoIncrement metadata.
  const templates: Table =
    db.dialect === "mysql"
      ? mysqlTable(getTableName(definedTemplates), {
          id: int("id").primaryKey().autoincrement(),
          userId: varchar("user_id", { length: KEY_LENGTH }).notNull(),
          name: varchar("name", { length: 100 }).notNull(),
          layout: longtext("layout").notNull(),
        })
      : definedTemplates;
  // shortcut: cap serialization is per backend instance; use DB locking before multi-process writers.
  const templateCreates = new Map<string, Promise<LayoutTemplateRow | null>>();
  const client = () => db.client<Drizzle>();
  async function findOne(table: Table, userId: string, hostId: number) {
    const drizzle = await client();
    const rows = await drizzle
      .select()
      .from(table)
      .where(and(eq(table.userId, userId), eq(table.hostId, hostId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async function upsert(
    table: Table,
    userId: string,
    hostId: number,
    values: Record<string, unknown>,
  ) {
    const drizzle = await client();
    const now = sqlTimestamp(new Date());
    const existing = await findOne(table, userId, hostId);
    if (existing) {
      await drizzle
        .update(table)
        .set({ ...values, updatedAt: now })
        .where(eq(table.id, existing.id));
    } else {
      await drizzle.insert(table).values({
        ...values,
        userId,
        hostId,
        createdAt: now,
        updatedAt: now,
      });
    }
    await db.persist();
  }

  return {
    /** The tables desktop sync reads and writes directly. */
    syncTables: { preferences, templates: definedTemplates },

    async findLayout(userId: string, hostId: number): Promise<string | null> {
      return (await findOne(preferences, userId, hostId))?.layout ?? null;
    },

    saveLayout(userId: string, hostId: number, layout: string) {
      return upsert(preferences, userId, hostId, { layout });
    },

    async findChecks(
      userId: string,
      hostId: number,
    ): Promise<{ checks: string; intervalSeconds: number } | null> {
      return findOne(checks, userId, hostId);
    },

    saveChecks(
      userId: string,
      hostId: number,
      json: string,
      intervalSeconds: number,
    ) {
      return upsert(checks, userId, hostId, { checks: json, intervalSeconds });
    },

    /** Every saved layout of one user, for export. */
    async listUserLayouts(
      userId: string,
    ): Promise<Array<{ hostId: number; layout: string }>> {
      const drizzle = await client();
      const rows = await drizzle
        .select({ hostId: preferences.hostId, layout: preferences.layout })
        .from(preferences)
        .where(eq(preferences.userId, userId));
      return rows.map((row: Record<string, unknown>) => ({
        hostId: Number(row.hostId),
        layout: String(row.layout ?? ""),
      }));
    },

    /** Import: adds old samples that are not already stored. */
    async importSamples(
      hostId: number,
      rows: MetricsHistoryRow[],
    ): Promise<number> {
      if (rows.length === 0) return 0;
      const drizzle = await client();
      const times = rows.map((row) => row.ts).sort();
      const have = new Set<string>(
        (
          await drizzle
            .select({ ts: history.ts })
            .from(history)
            .where(
              and(
                eq(history.hostId, hostId),
                gte(history.ts, times[0]),
                lte(history.ts, times[times.length - 1]),
              ),
            )
        ).map((row: { ts: string }) => row.ts),
      );
      const fresh = rows.filter((row) => !have.has(row.ts));
      for (let i = 0; i < fresh.length; i += 200) {
        await drizzle
          .insert(history)
          .values(fresh.slice(i, i + 200).map((row) => ({ ...row, hostId })));
      }
      if (fresh.length) await db.persist({ lazy: true });
      return fresh.length;
    },

    /** Import: adds old health results that are not already stored. */
    async importHealth(
      userId: string,
      hostId: number,
      rows: HealthHistoryRow[],
    ): Promise<number> {
      if (rows.length === 0) return 0;
      const drizzle = await client();
      const have = new Set<string>(
        (
          await drizzle
            .select({ ts: health.ts, checkId: health.checkId })
            .from(health)
            .where(and(eq(health.userId, userId), eq(health.hostId, hostId)))
        ).map(
          (row: { ts: string; checkId: string }) => `${row.checkId}|${row.ts}`,
        ),
      );
      const fresh = rows.filter((row) => !have.has(`${row.checkId}|${row.ts}`));
      for (let i = 0; i < fresh.length; i += 200) {
        await drizzle
          .insert(health)
          .values(
            fresh.slice(i, i + 200).map((row) => ({ ...row, userId, hostId })),
          );
      }
      if (fresh.length) await db.persist({ lazy: true });
      return fresh.length;
    },

    async listTemplates(userId: string): Promise<LayoutTemplateRow[]> {
      const drizzle = await client();
      return drizzle
        .select({
          id: templates.id,
          name: templates.name,
          layout: templates.layout,
        })
        .from(templates)
        .where(eq(templates.userId, userId))
        .orderBy(asc(templates.id));
    },

    async findTemplate(
      userId: string,
      id: number,
    ): Promise<LayoutTemplateRow | null> {
      const drizzle = await client();
      const rows = await drizzle
        .select({
          id: templates.id,
          name: templates.name,
          layout: templates.layout,
        })
        .from(templates)
        .where(and(eq(templates.userId, userId), eq(templates.id, id)))
        .limit(1);
      return rows[0] ?? null;
    },

    async createTemplate(
      userId: string,
      values: Omit<LayoutTemplateRow, "id">,
    ): Promise<LayoutTemplateRow | null> {
      const pending = (templateCreates.get(userId) ?? Promise.resolve())
        .catch(() => {})
        .then(async () => {
          const drizzle = await client();
          const [total] = await drizzle
            .select({ value: count() })
            .from(templates)
            .where(eq(templates.userId, userId));
          if (total.value >= MAX_TEMPLATES) return null;
          const insert = drizzle
            .insert(templates)
            .values({ userId, ...values });
          const [row] = await (db.dialect === "mysql"
            ? insert.$returningId()
            : insert.returning({ id: templates.id }));
          await db.persist();
          return { id: Number(row.id), ...values };
        });
      templateCreates.set(userId, pending);
      try {
        return await pending;
      } finally {
        if (templateCreates.get(userId) === pending)
          templateCreates.delete(userId);
      }
    },

    async deleteTemplate(userId: string, id: number): Promise<void> {
      const drizzle = await client();
      await drizzle
        .delete(templates)
        .where(and(eq(templates.userId, userId), eq(templates.id, id)));
      await db.persist();
    },

    /** One user's saved sets of checks, for the dashboard summary. */
    async listUserChecks(userId: string): Promise<HealthChecksRow[]> {
      const drizzle = await client();
      const rows = await drizzle
        .select({
          userId: checks.userId,
          hostId: checks.hostId,
          checks: checks.checks,
          intervalSeconds: checks.intervalSeconds,
        })
        .from(checks)
        .where(eq(checks.userId, userId));
      return rows.map((row: Record<string, unknown>) => ({
        userId: String(row.userId),
        hostId: Number(row.hostId),
        checks: String(row.checks ?? ""),
        intervalSeconds: Number(row.intervalSeconds) || 0,
      }));
    },

    /** Every saved set of checks, for the scheduler. */
    async listAllChecks(): Promise<HealthChecksRow[]> {
      const drizzle = await client();
      const rows = await drizzle
        .select({
          userId: checks.userId,
          hostId: checks.hostId,
          checks: checks.checks,
          intervalSeconds: checks.intervalSeconds,
        })
        .from(checks);
      return rows.map((row: Record<string, unknown>) => ({
        userId: String(row.userId),
        hostId: Number(row.hostId),
        checks: String(row.checks ?? ""),
        intervalSeconds: Number(row.intervalSeconds) || 0,
      }));
    },

    /** Adds results and keeps only the newest `keep` rows for the host. */
    async recordHealth(
      userId: string,
      hostId: number,
      results: HealthResultInput[],
      keep: number,
    ): Promise<void> {
      if (results.length === 0) return;
      const drizzle = await client();
      const ts = sqlTimestamp(new Date());
      await drizzle
        .insert(health)
        .values(results.map((result) => ({ ...result, userId, hostId, ts })));
      const scope = and(eq(health.userId, userId), eq(health.hostId, hostId));
      const retained = await drizzle
        .select({ id: health.id })
        .from(health)
        .where(scope)
        .orderBy(desc(health.ts), desc(health.id))
        .limit(keep);
      await drizzle.delete(health).where(
        retained.length
          ? and(
              scope,
              notInArray(
                health.id,
                retained.map((row: { id: number }) => row.id),
              ),
            )
          : scope,
      );
      await db.persist({ lazy: true });
    },

    async listHealth(
      userId: string,
      hostId: number,
      limit: number,
    ): Promise<HealthHistoryRow[]> {
      const drizzle = await client();
      const rows = await drizzle
        .select()
        .from(health)
        .where(and(eq(health.userId, userId), eq(health.hostId, hostId)))
        .orderBy(desc(health.ts), desc(health.id))
        .limit(limit);
      return rows.map((row: Record<string, unknown>) => ({
        checkId: row.checkId as string,
        ts: row.ts as string,
        ok: row.ok === true || row.ok === 1,
        latencyMs: (row.latencyMs as number | null) ?? null,
        detail: (row.detail as string | null) ?? null,
      }));
    },

    /**
     * Keeps at most one sample a minute per host and drops the ones past the
     * retention. On SQLite every save rewrites the whole database, so history
     * must stay small and must not cause a save for each sample.
     */
    async recordSample(
      input: MetricsHistoryInput,
      retentionDays: number,
    ): Promise<void> {
      const nowMs = Date.now();
      const last = sampleTimes.get(input.hostId);
      if (last && nowMs - last.written < SAMPLE_GAP_MS) return;
      const drizzle = await client();
      const now = new Date(nowMs);
      await drizzle.insert(history).values({ ...input, ts: sqlTimestamp(now) });
      const entry = last ?? { written: nowMs, pruned: 0 };
      entry.written = nowMs;
      sampleTimes.set(input.hostId, entry);
      if (nowMs - entry.pruned >= PRUNE_GAP_MS) {
        entry.pruned = nowMs;
        const cutoff = new Date(nowMs - retentionDays * 86_400_000);
        await drizzle
          .delete(history)
          .where(
            and(
              eq(history.hostId, input.hostId),
              lt(history.ts, sqlTimestamp(cutoff)),
            ),
          );
      }
      if (nowMs - lastHistoryPersist >= HISTORY_PERSIST_GAP_MS) {
        lastHistoryPersist = nowMs;
        await db.persist({ lazy: true });
      }
    },

    async listSamples(
      hostId: number,
      fromTs: string,
      toTs: string,
    ): Promise<MetricsHistoryRow[]> {
      const drizzle = await client();
      return drizzle
        .select({
          ts: history.ts,
          cpuPercent: history.cpuPercent,
          memPercent: history.memPercent,
          diskPercent: history.diskPercent,
          netRxBytes: history.netRxBytes,
          netTxBytes: history.netTxBytes,
        })
        .from(history)
        .where(
          and(
            eq(history.hostId, hostId),
            gte(history.ts, fromTs),
            lte(history.ts, toTs),
          ),
        )
        .orderBy(asc(history.ts));
    },
  };
}
