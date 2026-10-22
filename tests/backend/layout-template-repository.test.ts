import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@termix-ssh/plugin-sdk/testing";
import type { PluginDatabase } from "@termix-ssh/plugin-sdk/backend";
import { drizzle as mysql } from "drizzle-orm/mysql-proxy";
import { drizzle as postgres } from "drizzle-orm/pg-proxy";
import {
  createHostMetricsRepository,
  type HostMetricsRepository,
} from "../../src/backend/repository.js";
import { MAX_TEMPLATES } from "../../src/shared/layout-templates.js";
import { pluginDir } from "./server";

let db: TestDb;
let repository: HostMetricsRepository;
const values = { name: "Same name", layout: '{"columns":2,"slots":[]}' };

beforeEach(async () => {
  db = await createTestDb(pluginDir);
  db.sqlite.exec("INSERT INTO users (id) VALUES ('user-1'), ('user-2')");
  repository = await createHostMetricsRepository(db.database);
});
afterEach(() => db?.close());

describe("layout template repository on real SQLite", () => {
  it("creates, reads and deletes by the owning user, preserving duplicate names and snapshots", async () => {
    const first = await repository.createTemplate("user-1", values);
    const second = await repository.createTemplate("user-1", values);
    const other = await repository.createTemplate("user-2", values);
    expect(first?.id).toBeGreaterThan(0);
    expect(new Set([first!.id, second!.id, other!.id]).size).toBe(3);
    expect(await repository.listTemplates("user-1")).toEqual([first, second]);
    expect(await repository.findTemplate("user-2", first!.id)).toBeNull();
    await repository.deleteTemplate("user-2", first!.id);
    expect(await repository.findTemplate("user-1", first!.id)).toEqual(first);
    await repository.deleteTemplate("user-1", first!.id);
    expect(await repository.findTemplate("user-1", first!.id)).toBeNull();
    expect(await repository.listTemplates("user-1")).toEqual([second]);
    expect(await repository.listTemplates("user-2")).toEqual([other]);
    expect(db.persisted).toBe(5);
  });

  it("returns each insert's own ID during concurrent creations, including duplicate names and identical snapshots", async () => {
    const inputs = Array.from({ length: 30 }, (_, i) => ({
      userId: i % 2 ? "user-1" : "user-2",
      values: {
        ...values,
        layout: i % 3 ? values.layout : '{"columns":1,"slots":[]}',
      },
    }));
    const rows = await Promise.all(
      inputs.map((input) =>
        repository.createTemplate(input.userId, input.values),
      ),
    );
    expect(new Set(rows.map((row) => row!.id)).size).toBe(inputs.length);
    for (const [i, row] of rows.entries()) {
      expect(row).toEqual({ id: expect.any(Number), ...inputs[i].values });
      expect(await repository.findTemplate(inputs[i].userId, row!.id)).toEqual(
        row,
      );
    }
    expect(db.persisted).toBe(inputs.length);
  });

  it("does not exceed the per-user cap when many creates arrive together", async () => {
    const rows = await Promise.all(
      Array.from({ length: MAX_TEMPLATES + 10 }, () =>
        repository.createTemplate("user-1", values),
      ),
    );
    expect(rows.filter(Boolean)).toHaveLength(MAX_TEMPLATES);
    expect(rows.filter((row) => row === null)).toHaveLength(10);
    expect(await repository.listTemplates("user-1")).toHaveLength(
      MAX_TEMPLATES,
    );
    expect(await repository.createTemplate("user-2", values)).not.toBeNull();
    await repository.deleteTemplate("user-1", rows[0]!.id);
    expect(await repository.createTemplate("user-1", values)).not.toBeNull();
  });

  it("releases the creation queue after a failed insert without blocking the next request", async () => {
    db.sqlite.exec(
      "CREATE TRIGGER reject_template BEFORE INSERT ON p_host_metrics_layout_templates WHEN NEW.name = 'reject' BEGIN SELECT RAISE(FAIL, 'test failure'); END",
    );
    const [failed, succeeded] = await Promise.allSettled([
      repository.createTemplate("user-1", { ...values, name: "reject" }),
      repository.createTemplate("user-1", values),
    ]);
    expect(failed.status).toBe("rejected");
    expect(succeeded.status).toBe("fulfilled");
    expect(await repository.listTemplates("user-1")).toEqual([
      succeeded.status === "fulfilled" ? succeeded.value : null,
    ]);
    expect(db.persisted).toBe(1);
  });
});

describe("installed Drizzle dialect contracts (no database server)", () => {
  it.each(["mysql", "postgres"] as const)(
    "uses insert-local IDs on %s, not a latest-row/name readback",
    async (dialect) => {
      const execute = vi.fn(async (query: string) => {
        if (query.startsWith("select count(")) return { rows: [[0]] };
        if (query.startsWith("insert into"))
          return {
            rows:
              dialect === "mysql"
                ? [{ insertId: 42, affectedRows: 1 }]
                : [[42]],
          };
        throw new Error(`Unexpected query: ${query}`);
      });
      const handle = dialect === "mysql" ? mysql(execute) : postgres(execute);
      const database: PluginDatabase = {
        ...db.database,
        dialect,
        client: async <T>() => handle as T,
      };
      const repository = await createHostMetricsRepository(database);
      expect(await repository.createTemplate("user-1", values)).toEqual({
        id: 42,
        ...values,
      });
      expect(execute).toHaveBeenCalledTimes(2);
      const insertSql = execute.mock.calls[1][0];
      expect(insertSql).toContain("p_host_metrics_layout_templates");
      if (dialect === "mysql") {
        expect(insertSql).toContain("values (default, ?, ?, ?)");
        expect(insertSql).not.toContain("returning");
      } else {
        expect(insertSql).toContain('returning "id"');
      }
    },
  );
});
