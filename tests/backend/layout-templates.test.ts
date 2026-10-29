import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer, testHost, type TestServer } from "./server";
import {
  MAX_TEMPLATES,
  templateLayout,
} from "../../src/shared/layout-templates.js";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});
const base = "/host-metrics/layout-templates";
const layout = {
  columns: 2,
  slots: [
    {
      id: "memory",
      order: 1,
      colSpan: 2,
      height: 480,
      width: 573,
      settings: { chartSize: "large", showDetails: false },
    },
    {
      id: "cpu",
      order: 0,
      colSpan: 1,
      height: null,
      settings: { showCores: false },
    },
  ],
};
const input = { name: " Personal dashboard ", layout };
async function create(body: unknown = input, user = "user-1") {
  const response = await server!.request("POST", base, { body, user });
  expect(response.status).toBe(200);
  return response.body;
}
function saved(hostId: number, userId = "user-1") {
  const row = server!.db.sqlite
    .prepare(
      "SELECT layout FROM p_host_metrics_host_metrics_preferences WHERE user_id = ? AND host_id = ?",
    )
    .get(userId, hostId) as { layout: string } | undefined;
  return row ? JSON.parse(row.layout) : null;
}
const endpoints: Array<[string, string, unknown?]> = [
  ["GET", base],
  ["POST", base, input],
  ["DELETE", `${base}/1`],
  ["GET", `${base}/hosts`],
  ["POST", `${base}/1/apply`, { hostIds: [7] }],
];

describe("personal dashboard layout templates", () => {
  it.each(endpoints)(
    "%s %s requires plugin permission and an actor",
    async (method, path, body) => {
      server = await startServer({ permissions: [] });
      expect((await server.request(method, path, { body })).status).toBe(403);
      await server.close();
      server = await startServer();
      expect(
        (await server.request(method, path, { body, user: "" })).status,
      ).toBe(401);
    },
  );
  it("creates, lists and deletes only personal snapshots; ignores supplied ownership", async () => {
    server = await startServer();
    const row = await create({ ...input, userId: "user-2" });
    expect(row).toEqual({
      id: expect.any(Number),
      name: "Personal dashboard",
      layout,
    });
    expect((await server.request("GET", base)).body.templates).toEqual([row]);
    expect(
      (await server.request("GET", base, { user: "user-2" })).body.templates,
    ).toEqual([]);
    for (const [method, path, body] of [
      ["DELETE", `${base}/${row.id}`],
      ["POST", `${base}/${row.id}/apply`, { hostIds: [7] }],
    ] as Array<[string, string, unknown?]>) {
      expect(
        (await server.request(method, path, { body, user: "user-2" })).status,
      ).toBe(404);
    }
    expect(saved(7)).toBeNull();
    await server.request("DELETE", `${base}/${row.id}`);
    expect((await server.request("GET", base)).body.templates).toEqual([]);
  });
  it("skips corrupt saved layouts without hiding valid templates or exposing another user's rows", async () => {
    server = await startServer();
    const first = await create();
    const insert = server.db.sqlite.prepare(
      "INSERT INTO p_host_metrics_layout_templates (user_id, name, layout) VALUES (?, ?, ?)",
    );
    insert.run("user-1", "Broken JSON", "{");
    insert.run("user-1", "Invalid layout", '{"columns":9,"slots":[]}');
    insert.run("user-1", "Invalid slots", '{"columns":2,"slots":[null]}');
    const last = await create({
      name: "Last",
      layout: { columns: 1, slots: [] },
    });
    await create({ name: "Private", layout }, "user-2");
    const response = await server.request("GET", base);
    expect(response.status).toBe(200);
    expect(response.body.templates).toEqual([first, last]);
    expect(
      server.db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM p_host_metrics_layout_templates")
        .get(),
    ).toEqual({ n: 6 });
  });
  it("caps concurrent creations at 50 per user, counts corrupt rows, and frees capacity on deletion", async () => {
    server = await startServer();
    const insert = server.db.sqlite.prepare(
      "INSERT INTO p_host_metrics_layout_templates (user_id, name, layout) VALUES (?, ?, ?)",
    );
    for (let i = 0; i < MAX_TEMPLATES - 1; i++)
      insert.run("user-1", `Saved ${i}`, "{");
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        server!.request("POST", base, { body: input }),
      ),
    );
    const accepted = responses.filter((r) => r.status === 200);
    expect(accepted).toHaveLength(1);
    const rejected = responses.filter((r) => r.status !== 200);
    expect(rejected).toHaveLength(7);
    for (const response of rejected)
      expect(response).toEqual({
        status: 400,
        body: { error: "too_many_templates" },
      });
    expect(
      server.db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM p_host_metrics_layout_templates WHERE user_id = ?",
        )
        .get("user-1"),
    ).toEqual({ n: MAX_TEMPLATES });
    await create(input, "user-2");
    expect(
      (await server.request("DELETE", `${base}/${accepted[0].body.id}`)).status,
    ).toBe(200);
    await create();
  });
  it("lists only connect-accessible hosts and never returns credentials", async () => {
    const hosts = [testHost(7), testHost(8)];
    hosts[0].summary.folder = "Production" as never;
    server = await startServer({
      hosts: [7, 8],
      mock: { hosts: hosts.map((h) => h.summary) },
    });
    const access = server.mock.ctx.hosts.checkAccess;
    server.mock.ctx.hosts.checkAccess = async (id, level) =>
      id === 8
        ? { hasAccess: false, isOwner: false, isShared: false }
        : access(id, level);
    expect((await server.request("GET", `${base}/hosts`)).body).toEqual({
      hosts: [{ id: 7, name: "host-7", folder: "Production" }],
    });
  });
  it("replaces selected personal layouts once and syncs only owners' enabledWidgets, preserving other users, health data and sampling settings without SSH", async () => {
    server = await startServer({ hosts: [7, 8, 9] });
    const ssh = vi
      .spyOn(server.mock.ctx.ssh, "withConnection")
      .mockRejectedValue(new Error("must not connect"));
    for (const hostId of [7, 8, 9]) {
      await server.mock.ctx.settings.setHost(hostId, "metricsEnabled", false);
      await server.mock.ctx.settings.setHost(hostId, "metricsInterval", 90);
      await server.mock.ctx.settings.setHost(hostId, "enabledWidgets", [
        "disk",
      ]);
    }
    const settings = vi.spyOn(server.mock.ctx.settings, "setHost");
    const scheduled = server.mock.scheduled.length;
    server.db.sqlite
      .exec(`INSERT INTO p_host_metrics_host_metrics_preferences (user_id, host_id, layout) VALUES
      ('user-1',7,'{"columns":3,"slots":[]}'),('user-2',7,'{"columns":4,"slots":[]}'),('user-1',9,'{"columns":1,"slots":[]}');
      INSERT INTO p_host_metrics_host_health_checks (user_id, host_id, checks, interval_seconds) VALUES ('user-1',7,'[]',600);
      INSERT INTO p_host_metrics_host_health_history (user_id,host_id,check_id,ok,detail) VALUES ('user-1',7,'web',1,'open');`);
    const row = await create();
    expect(settings).not.toHaveBeenCalled();
    expect(
      (
        await server.request("POST", `${base}/${row.id}/apply`, {
          body: { hostIds: [7, 8, 7], userId: "user-2" },
        })
      ).body.results,
    ).toEqual([
      { hostId: 7, applied: true },
      { hostId: 8, applied: true },
    ]);
    expect(saved(7)).toEqual(layout);
    expect(saved(8)).toEqual(layout);
    expect(saved(7, "user-2")).toEqual({ columns: 4, slots: [] });
    expect(saved(9)).toEqual({ columns: 1, slots: [] });
    expect(
      server.db.sqlite
        .prepare(
          "SELECT checks, interval_seconds FROM p_host_metrics_host_health_checks",
        )
        .all(),
    ).toEqual([{ checks: "[]", interval_seconds: 600 }]);
    expect(
      server.db.sqlite
        .prepare("SELECT detail FROM p_host_metrics_host_health_history")
        .all(),
    ).toEqual([{ detail: "open" }]);
    await server.request("DELETE", `${base}/${row.id}`);
    expect(saved(7)).toEqual(layout);
    expect(ssh).not.toHaveBeenCalled();
    expect(settings.mock.calls).toEqual([
      [7, "enabledWidgets", ["cpu", "memory"]],
      [8, "enabledWidgets", ["cpu", "memory"]],
    ]);
    expect(await server.mock.ctx.settings.getHost(9, "enabledWidgets")).toEqual(
      ["disk"],
    );
    for (const hostId of [7, 8, 9]) {
      expect(
        await server.mock.ctx.settings.getHost(hostId, "metricsEnabled"),
      ).toBe(false);
      expect(
        await server.mock.ctx.settings.getHost(hostId, "metricsInterval"),
      ).toBe(90);
    }
    expect(server.mock.scheduled).toHaveLength(scheduled);
    expect(
      server.db.sqlite
        .prepare(
          "SELECT COUNT(*) AS n FROM p_host_metrics_host_metrics_history",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
  it("allows connect-only shared hosts but saves only the acting user's preference", async () => {
    server = await startServer();
    server.mock.ctx.hosts.checkAccess = async () => ({
      hasAccess: true,
      isOwner: false,
      isShared: true,
    });
    const settings = vi.spyOn(server.mock.ctx.settings, "setHost");
    const ssh = vi.spyOn(server.mock.ctx.ssh, "withConnection");
    const row = await create(input, "user-2");
    expect(
      (
        await server.request("POST", `${base}/${row.id}/apply`, {
          user: "user-2",
          body: { hostIds: [7] },
        })
      ).body.results,
    ).toEqual([{ hostId: 7, applied: true }]);
    expect(saved(7, "user-2")).toEqual(layout);
    expect(saved(7)).toBeNull();
    expect(settings).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });
  it("matches preferences for contributed cards and intentionally empty owner dashboards", async () => {
    server = await startServer();
    const settings = vi.spyOn(server.mock.ctx.settings, "setHost");
    for (const slots of [[{ id: "plugin_custom", order: 0 }], []]) {
      const row = await create({
        name: "Non-sampling dashboard",
        layout: { columns: 1, slots },
      });
      expect(
        (
          await server.request("POST", `${base}/${row.id}/apply`, {
            body: { hostIds: [7] },
          })
        ).body.results,
      ).toEqual([{ hostId: 7, applied: true }]);
      expect(settings).toHaveBeenLastCalledWith(7, "enabledWidgets", []);
      expect(
        await server.mock.ctx.settings.getHost(7, "enabledWidgets"),
      ).toEqual([]);
    }
    expect(settings).toHaveBeenCalledTimes(2);
  });
  it("reports an owner enabledWidgets write failure and allows a retry", async () => {
    server = await startServer();
    const row = await create();
    const settings = vi
      .spyOn(server.mock.ctx.settings, "setHost")
      .mockRejectedValueOnce(new Error("settings unavailable"));
    const apply = () =>
      server!.request("POST", `${base}/${row.id}/apply`, {
        body: { hostIds: [7] },
      });
    expect((await apply()).body.results).toEqual([
      { hostId: 7, applied: false, error: "save_failed" },
    ]);
    expect(saved(7)).toEqual(layout);
    expect((await apply()).body.results).toEqual([
      { hostId: 7, applied: true },
    ]);
    expect(settings).toHaveBeenLastCalledWith(7, "enabledWidgets", [
      "cpu",
      "memory",
    ]);
  });
  it("reports revoked access and per-host persistence errors, then retries independently", async () => {
    server = await startServer({ hosts: [7, 8, 9] });
    const row = await create();
    const access = server.mock.ctx.hosts.checkAccess;
    server.mock.ctx.hosts.checkAccess = async (id, level) =>
      id === 8
        ? { hasAccess: false, isOwner: false, isShared: false }
        : access(id, level);
    server.db.sqlite.exec(
      "CREATE TRIGGER reject_layout BEFORE INSERT ON p_host_metrics_host_metrics_preferences WHEN NEW.host_id = 9 BEGIN SELECT RAISE(FAIL, 'test failure'); END",
    );
    expect(
      (
        await server.request("POST", `${base}/${row.id}/apply`, {
          body: { hostIds: [7, 8, 9] },
        })
      ).body.results,
    ).toEqual([
      { hostId: 7, applied: true },
      { hostId: 8, applied: false, error: "access_denied" },
      { hostId: 9, applied: false, error: "save_failed" },
    ]);
    expect(saved(7)).toEqual(layout);
    expect(saved(8)).toBeNull();
    expect(saved(9)).toBeNull();
    server.mock.ctx.hosts.checkAccess = access;
    server.db.sqlite.exec("DROP TRIGGER reject_layout");
    expect(
      (
        await server.request("POST", `${base}/${row.id}/apply`, {
          body: { hostIds: [8, 9] },
        })
      ).body.results,
    ).toEqual([
      { hostId: 8, applied: true },
      { hostId: 9, applied: true },
    ]);
  });
  it.each([
    {},
    { ...input, name: " " },
    { ...input, name: "x".repeat(101) },
    { ...input, layout: null },
    { ...input, layout: { slots: [], columns: 9 } },
    { ...input, layout: { slots: [null], columns: 3 } },
    { ...input, layout: { slots: [{ id: "cpu" }, { id: "cpu" }], columns: 3 } },
  ])("rejects malformed templates %j", async (body) => {
    server = await startServer();
    expect((await server.request("POST", base, { body })).status).toBe(400);
    expect((await server.request("GET", base)).body.templates).toEqual([]);
  });
  it.each([
    [],
    ["7"],
    [0],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    Array(101).fill(7),
    null,
  ])("rejects invalid host IDs %j", async (hostIds) => {
    server = await startServer();
    const row = await create();
    expect(
      (
        await server.request("POST", `${base}/${row.id}/apply`, {
          body: { hostIds },
        })
      ).status,
    ).toBe(400);
    expect(saved(7)).toBeNull();
  });
  it.each(["abc", "0", "-1", "9007199254740992"])(
    "rejects invalid template ID %s",
    async (id) => {
      server = await startServer();
      expect((await server.request("DELETE", `${base}/${id}`)).status).toBe(
        400,
      );
    },
  );
  it("sanitizes using preference rules, preserves contributed cards, and permits an intentionally empty dashboard", async () => {
    expect(templateLayout(null)).toBeNull();
    expect(
      templateLayout({
        columns: 3,
        slots: [
          {
            id: "plugin_custom",
            order: 2,
            width: -1,
            height: 99_999,
            settings: { secret: "discard" },
          },
        ],
      }),
    ).toEqual({
      columns: 3,
      slots: [
        {
          id: "plugin_custom",
          order: 2,
          width: 280,
          height: 10000,
          colSpan: 1,
        },
      ],
    });
    server = await startServer();
    expect(
      (await create({ name: "Empty", layout: { columns: 1, slots: [] } }))
        .layout,
    ).toEqual({ columns: 1, slots: [] });
  });
});
