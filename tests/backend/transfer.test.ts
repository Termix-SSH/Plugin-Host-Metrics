import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const layout = {
  columns: 2,
  slots: [
    { id: "cpu", order: 0, colSpan: 1, height: null, settings: {} },
    { id: "memory", order: 1, colSpan: 1, height: null, settings: {} },
  ],
};
const check = {
  id: "c1",
  name: "Web",
  type: "port",
  target: "127.0.0.1",
  port: 80,
};

async function seed() {
  await server!.request("POST", "/host-metrics/preferences/7", {
    body: layout,
  });
  await server!.request("POST", "/host-metrics/layout-templates", {
    body: { name: "Mine", layout },
  });
  const ts = new Date().toISOString().slice(0, 19).replace("T", " ");
  server!.db.sqlite
    .prepare(
      "INSERT INTO p_host_metrics_host_metrics_history (host_id, ts, cpu_percent) VALUES (7, ?, 12)",
    )
    .run(ts);
}

describe("export and import", () => {
  it("requires the permission and an actor", async () => {
    server = await startServer({ permissions: [] });
    expect((await server.request("GET", "/export")).status).toBe(403);
    expect((await server.request("POST", "/import", { body: {} })).status).toBe(
      403,
    );
    await server.close();
    server = await startServer();
    expect((await server.request("GET", "/export", { user: "" })).status).toBe(
      401,
    );
  });

  it("exports layouts, templates and history", async () => {
    server = await startServer();
    await seed();
    const res = await server.request("GET", "/export?history=1");
    expect(res.status).toBe(200);
    expect(res.body.plugin).toBe("host-metrics");
    expect(res.body.hosts).toHaveLength(1);
    expect(res.body.hosts[0].match.ip).toBe("10.0.0.7");
    expect(res.body.hosts[0].layout.columns).toBe(2);
    expect(res.body.hosts[0].history.metrics).toHaveLength(1);
    expect(res.body.templates).toMatchObject([{ name: "Mine" }]);
    const plain = await server.request("GET", "/export");
    expect(plain.body.hosts[0].history).toBeUndefined();
  });

  it("does not export another user's data", async () => {
    server = await startServer();
    await seed();
    const res = await server.request("GET", "/export", { user: "user-2" });
    expect(res.body.hosts).toEqual([]);
    expect(res.body.templates).toEqual([]);
  });

  it("imports onto a host matched by address and skips unknown ones", async () => {
    server = await startServer({ hosts: [7, 8] });
    await seed();
    const file = (await server.request("GET", "/export?history=1")).body;
    file.hosts[0].match = { ...file.hosts[0].match, ip: "10.0.0.8" };
    file.hosts.push({
      match: { name: "x", ip: "9.9.9.9", port: 22, username: "root" },
      layout,
    });
    const res = await server.request("POST", "/import", {
      body: { data: file },
    });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBeGreaterThanOrEqual(2);
    expect(res.body.failed).toBe(0);
    const back = (await server.request("GET", "/export?history=1")).body;
    const eight = back.hosts.find(
      (h: { match: { ip: string } }) => h.match.ip === "10.0.0.8",
    );
    expect(eight.layout.columns).toBe(2);
    expect(eight.history.metrics).toHaveLength(1);
  });

  it("keeps existing data unless overwrite is set and never duplicates history", async () => {
    server = await startServer();
    await seed();
    const file = (await server.request("GET", "/export?history=1")).body;
    file.hosts[0].layout = { ...layout, columns: 3 };
    file.hosts[0].checks = [check];
    const kept = await server.request("POST", "/import", {
      body: { data: file },
    });
    expect(kept.body.updated).toBe(0);
    expect(
      (await server.request("GET", "/host-metrics/preferences/7")).body.layout
        .columns,
    ).toBe(2);
    const over = await server.request("POST", "/import", {
      body: { data: file, overwrite: true },
    });
    expect(over.body.updated).toBeGreaterThanOrEqual(1);
    expect(
      (await server.request("GET", "/host-metrics/preferences/7")).body.layout
        .columns,
    ).toBe(3);
    const rows = server.db.sqlite
      .prepare("SELECT COUNT(*) AS n FROM p_host_metrics_host_metrics_history")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("rejects files that are not a Host Metrics export", async () => {
    server = await startServer();
    for (const data of [
      null,
      {},
      { plugin: "x", schema: 1, hosts: [] },
      {
        plugin: "host-metrics",
        schema: 2,
        hosts: [],
      },
    ]) {
      const res = await server.request("POST", "/import", { body: { data } });
      expect(res.status).toBe(400);
    }
  });

  it("reports invalid layouts without failing the whole import", async () => {
    server = await startServer();
    const res = await server.request("POST", "/import", {
      body: {
        data: {
          plugin: "host-metrics",
          schema: 1,
          hosts: [
            {
              match: {
                name: "host-7",
                ip: "10.0.0.7",
                port: 22,
                username: "root",
              },
              layout: { columns: 99, slots: [] },
            },
          ],
        },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.failed).toBe(1);
  });
});
