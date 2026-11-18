import { afterEach, describe, expect, it } from "vitest";
import { startServer, type TestServer } from "./server";
import { createHostMetricsRepository } from "../../src/backend/repository.js";

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("swap history", () => {
  it("persists swap samples and exposes them through history and export/import", async () => {
    server = await startServer({ hosts: [7, 8] });
    const repository = await createHostMetricsRepository(server.mock.ctx.db);
    await repository.recordSample(
      {
        hostId: 7,
        cpuPercent: 10,
        memPercent: 20,
        swapPercent: 12.5,
        diskPercent: 30,
        netRxBytes: 0,
        netTxBytes: 0,
      },
      7,
    );
    const history = await server.request("GET", "/metrics/history/7?range=1h");
    expect(history.status).toBe(200);
    expect(history.body.rows).toEqual([
      expect.objectContaining({ swap_percent: 12.5, mem_percent: 20 }),
    ]);
    const exported = await server.request("GET", "/export?history=1");
    const file = exported.body;
    expect(file.hosts[0].history.metrics[0].swapPercent).toBe(12.5);
    file.hosts[0].match.ip = "10.0.0.8";
    expect(
      (await server.request("POST", "/import", { body: { data: file } }))
        .status,
    ).toBe(200);
    const imported = await server.request("GET", "/metrics/history/8?range=1h");
    expect(imported.body.rows[0].swap_percent).toBe(12.5);
  });

  it("leaves old samples null instead of inventing zero swap usage", async () => {
    server = await startServer();
    server.db.sqlite.exec(
      "INSERT INTO p_host_metrics_host_metrics_history (host_id) VALUES (7)",
    );
    const history = await server.request("GET", "/metrics/history/7?range=1h");
    expect(history.body.rows[0].swap_percent).toBeNull();
  });
});
