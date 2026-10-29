import { afterEach, describe, expect, it } from "vitest";
import {
  dashboardHealth,
  storedLevel,
  type HealthCheck,
} from "../../src/backend/managers/health.js";
import { startServer, type TestServer } from "./server.js";

const disk: HealthCheck = {
  id: "disk",
  name: "Audit log",
  type: "script",
  target: "",
  command: "df --output=pcent /var/log/audit | tail -1",
  kind: "number",
  unit: "%",
  warn: 80,
  crit: 90,
  dashboard: true,
};
const auditd: HealthCheck = {
  id: "auditd",
  name: "auditd",
  type: "script",
  target: "",
  command: "systemctl is-active auditd",
  kind: "status",
  dashboard: true,
};
const row = (
  checkId: string,
  ok: boolean,
  detail: string,
  ts = "2026-10-30 10:00:00",
) => ({
  checkId,
  ok,
  detail,
  ts,
  latencyMs: null,
});

describe("storedLevel", () => {
  it("reads number checks again with the current limits", () => {
    expect(storedLevel(disk, row("disk", true, "85%"))).toBe("warn");
    expect(storedLevel(disk, row("disk", true, "95%"))).toBe("crit");
    expect(storedLevel({ ...disk, crit: 99 }, row("disk", true, "95%"))).toBe(
      "warn",
    );
    expect(storedLevel(disk, row("disk", false, "no number in output"))).toBe(
      "crit",
    );
  });

  it("uses pass or fail for other checks", () => {
    expect(storedLevel(auditd, row("auditd", true, "active"))).toBe("ok");
    expect(storedLevel(auditd, row("auditd", false, "inactive"))).toBe("crit");
  });
});

describe("dashboardHealth", () => {
  it("keeps the newest result of each dashboard check and the worst level", () => {
    const summary = dashboardHealth(
      7,
      [disk, auditd, { ...auditd, id: "hidden", dashboard: false }],
      [
        row("disk", true, "85%", "2026-10-30 10:05:00"),
        row("auditd", true, "active", "2026-10-30 10:05:00"),
        row("hidden", false, "down", "2026-10-30 10:05:00"),
        row("disk", true, "40%", "2026-10-30 10:00:00"),
      ],
    )!;
    expect(summary.level).toBe("warn");
    expect(summary.checks.map((c) => [c.id, c.level, c.detail])).toEqual([
      ["disk", "warn", "85%"],
      ["auditd", "ok", "active"],
    ]);
  });

  it("returns nothing when no dashboard check has run", () => {
    expect(dashboardHealth(7, [disk], [])).toBeNull();
    expect(
      dashboardHealth(
        7,
        [{ ...disk, dashboard: false }],
        [row("disk", true, "1%")],
      ),
    ).toBeNull();
  });
});

describe("GET /health/summary", () => {
  let server: TestServer;
  afterEach(() => server?.close());

  it("lists the caller's dashboard checks on hosts they can reach", async () => {
    server = await startServer();
    const sql = server.db.sqlite;
    sql.prepare("INSERT INTO ssh_data (id) VALUES (99)").run();
    const save = sql.prepare(
      "INSERT INTO p_host_metrics_host_health_checks (user_id, host_id, checks, interval_seconds) VALUES (?, ?, ?, 300)",
    );
    save.run("user-1", 7, JSON.stringify([disk, auditd]));
    save.run("user-1", 99, JSON.stringify([disk]));
    save.run("user-2", 7, JSON.stringify([disk]));
    const result = sql.prepare(
      "INSERT INTO p_host_metrics_host_health_history (user_id, host_id, check_id, ok, detail) VALUES (?, ?, ?, ?, ?)",
    );
    result.run("user-1", 7, "disk", 1, "92%");
    result.run("user-1", 7, "auditd", 1, "active");
    result.run("user-1", 99, "disk", 0, "99%");
    result.run("user-2", 7, "disk", 1, "10%");

    const response = await server.request("GET", "/health/summary");
    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0]).toMatchObject({ hostId: 7, level: "crit" });
    expect(response.body[0].checks).toHaveLength(2);
  });

  it("needs host-metrics.use", async () => {
    server = await startServer({ permissions: [] });
    expect((await server.request("GET", "/health/summary")).status).toBe(403);
  });
});
