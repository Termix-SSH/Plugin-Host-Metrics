import { describe, expect, it } from "vitest";
import { compactRows } from "../../src/frontend/compact-metrics";
import type { ServerMetrics } from "../../src/shared/metrics";

const base = {
  cpu: { percent: 12.4, cores: 4, load: [0.1, 0.25, 0.5] },
  memory: { percent: 50, usedGiB: 4, totalGiB: 8 },
  disk: { percent: 80, usedHuman: "40G", totalHuman: "50G" },
  lastChecked: "now",
} as unknown as ServerMetrics;

describe("compactRows", () => {
  it("lists cpu, memory and disk with their percentages", () => {
    const rows = compactRows(base);
    expect(rows.map((row) => row.id)).toEqual(["cpu", "memory", "disk"]);
    expect(rows[0]).toMatchObject({ value: "12%", detail: "0.10  0.25  0.50" });
    expect(rows[1]).toMatchObject({ value: "50%", detail: "4.0 / 8.0 GiB" });
    expect(rows[2]).toMatchObject({ value: "80%", detail: "40G / 50G" });
  });

  it("adds temperature and uptime only when there is data", () => {
    const rows = compactRows(
      {
        ...base,
        temperature: { highestCelsius: 50 },
        uptime: { formatted: "3d 2h" },
      } as unknown as ServerMetrics,
      true,
    );
    expect(rows.map((row) => row.id)).toEqual([
      "cpu",
      "memory",
      "disk",
      "temperature",
      "uptime",
    ]);
    expect(rows[3].value).toBe("122.0°F");
  });

  it("shows N/A for missing numbers", () => {
    const rows = compactRows({
      ...base,
      cpu: { percent: null, cores: null, load: null },
    } as unknown as ServerMetrics);
    expect(rows[0].value).toBe("N/A");
  });
});
