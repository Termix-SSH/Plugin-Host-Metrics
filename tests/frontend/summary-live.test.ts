import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  live: null as unknown,
  calls: [] as Array<[unknown, boolean, number | null]>,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useSettings: () => ({ values: { liveInterval: "1" } }),
}));
vi.mock("../../src/frontend/live-metrics", async (orig) => ({
  ...(await orig<object>()),
  useLiveMetrics: (id: unknown, active: boolean, ms: number | null) => {
    mocks.calls.push([id, active, ms]);
    return mocks.live;
  },
}));
import { useMetricsSummary } from "../../src/frontend/summary-store";

const slow = {
  cpu: { percent: 10, cores: 2, load: [0, 0, 0] },
  memory: { percent: 10, usedGiB: 1, totalGiB: 10 },
  disk: { percent: 5, usedHuman: null, totalHuman: null },
} as never;
const store = {
  watch: () => () => {},
  get: () => slow,
} as never;

afterEach(() => {
  mocks.live = null;
  mocks.calls = [];
});

describe("useMetricsSummary live overlay", () => {
  it("overlays the live CPU, polls no faster than 5s even if the user picked 1s", () => {
    mocks.live = {
      cpu: 66,
      cores: [],
      coreIds: [],
      memTotalKb: 1000,
      memUsedKb: 500,
      memCachedKb: 0,
      memFreeKb: 0,
      swapTotalKb: 0,
      swapUsedKb: 0,
      load: [0, 0, 0],
      net: [],
      count: 0,
      running: 0,
      procs: [],
    };
    const { result } = renderHook(() => useMetricsSummary(store, 7));
    expect(result.current?.cpu.percent).toBe(66);
    expect(result.current?.memory.percent).toBe(50);
    expect(mocks.calls[0]).toEqual([7, true, 5000]);
  });

  it("does not poll live when the caller needs no live field or the host is offline", () => {
    renderHook(() => useMetricsSummary(store, 7, false));
    expect(mocks.calls[0]).toEqual([7, false, 5000]);
  });

  it("does not poll live when no host is shown", () => {
    renderHook(() => useMetricsSummary(store, null));
    expect(mocks.calls[0][1]).toBe(false);
  });
});
