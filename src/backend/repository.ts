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
export async function createHostMetricsRepository(db: PluginDatabase) {
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

    /** One sample, then drops the host's samples older than the retention. */
    async recordSample(
      input: MetricsHistoryInput,
      retentionDays: number,
    ): Promise<void> {
      const drizzle = await client();
      const now = new Date();
      await drizzle.insert(history).values({ ...input, ts: sqlTimestamp(now) });
      const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
      await drizzle
        .delete(history)
        .where(
          and(
            eq(history.hostId, input.hostId),
            lt(history.ts, sqlTimestamp(cutoff)),
          ),
        );
      // A sample every few seconds per host: let the debounced save pick it up.
      await db.persist({ lazy: true });
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
