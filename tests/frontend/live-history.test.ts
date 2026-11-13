import { describe, expect, it } from "vitest";
import { emptyHistories, pushLive } from "../../src/frontend/live-history";
import { liveDomain } from "../../src/frontend/cards/LiveUsage";
import type { ServerMetrics } from "../../src/shared/metrics.js";

const reading = (cpu: number | null) =>
  ({
    cpu: { percent: cpu },
    memory: { percent: 40 },
    disk: { percent: 7 },
  }) as unknown as ServerMetrics;

describe("pushLive", () => {
  it("keeps zero usage and missing/no-swap readings distinct in the swap series", () => {
    const swap = {
      totalBytes: 1024,
      usedBytes: 0,
      freeBytes: 1024,
      percent: 0,
    };
    let h = pushLive(emptyHistories(), { ...reading(0), swap }, 0);
    h = pushLive(h, { ...reading(0), swap: { ...swap, percent: 25 } }, 1000);
    h = pushLive(h, { ...reading(0), swap: null }, 2000);
    expect(h.swap).toEqual([0, 25, null]);
    expect(h.swap).toHaveLength(h.ts.length);
  });
  it("adds a timed point per reading and keeps the newest ones", () => {
    let h = emptyHistories();
    for (let i = 0; i < 5; i++) h = pushLive(h, reading(i), 1000 * i, 3);
    expect(h.cpu).toEqual([2, 3, 4]);
    expect(h.memory).toEqual([40, 40, 40]);
    expect(h.ts).toEqual([
      new Date(2000).toISOString(),
      new Date(3000).toISOString(),
      new Date(4000).toISOString(),
    ]);
  });

  it("replaces a reading taken at the same moment", () => {
    let h = pushLive(emptyHistories(), reading(null), 5000);
    h = pushLive(h, reading(12), 5000);
    expect(h.cpu).toEqual([12]);
    expect(h.ts).toHaveLength(1);
  });
});

describe("liveDomain", () => {
  it("scales to the data so small changes show", () => {
    expect(liveDomain([1, 2, 3])).toEqual([0, 4]);
    expect(liveDomain([10, 22])).toEqual([0, 40]);
    expect(liveDomain([90, null])).toEqual([0, 100]);
    expect(liveDomain([])).toEqual([0, 4]);
  });
});
