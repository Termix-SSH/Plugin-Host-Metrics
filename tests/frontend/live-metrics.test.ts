import { describe, it, expect } from "vitest";
import { liveIntervalMs, mergeLive } from "../../src/frontend/live-metrics";
import { memParts } from "../../src/frontend/live-metrics";
import type { LiveSample, ServerMetrics } from "../../src/shared/metrics";

describe("liveIntervalMs", () => {
  it("maps the setting to milliseconds, off to null, anything else to 2s", () => {
    expect(liveIntervalMs("off")).toBeNull();
    expect(liveIntervalMs("0.5")).toBe(500);
    expect(liveIntervalMs("1")).toBe(1000);
    expect(liveIntervalMs("5")).toBe(5000);
    expect(liveIntervalMs("2")).toBe(2000);
    expect(liveIntervalMs(undefined)).toBe(2000);
  });
});

describe("mergeLive", () => {
  it("splits memory into disjoint parts summing to 100, even when cache exceeds what is left", () => {
    const a = memParts(1000, 100, 700)!;
    expect(a.used + a.cache + a.free).toBeCloseTo(100);
    expect(a).toMatchObject({ used: 20, cache: 70, free: 10 });
    const b = memParts(1000, 100, 5000)!;
    expect(b.cache).toBe(90);
    expect(b.used).toBe(0);
    expect(memParts(0, 0, 0)).toBeNull();
  });

  const slow = {
    cpu: { percent: 10, cores: 2, load: [0, 0, 0] },
    memory: { percent: 10, usedGiB: 1, totalGiB: 10 },
    disk: { percent: 5, usedHuman: null, totalHuman: null },
    network: { interfaces: [{ name: "eth0", ip: "1.1.1.1", state: "UP" }] },
    lastChecked: "",
  } as unknown as ServerMetrics;
  const live: LiveSample = {
    cpu: 42.4,
    cores: [80, 5],
    coreIds: ["0", "2"],
    memTotalKb: 2 * 1024 * 1024,
    memUsedKb: 1024 * 1024,
    swapTotalKb: 0,
    swapUsedKb: 0,
    load: [1, 2, 3],
    net: [{ name: "eth0", rxBps: 10, txBps: 20 }],
    memCachedKb: 512 * 1024,
    memFreeKb: 256 * 1024,
    cpuMix: { user: 30, system: 10, iowait: 2, steal: 0 },
    count: 3,
    running: 1,
    procs: [
      {
        pid: 1,
        name: "init",
        cpu: 1.5,
        memKb: 1024 * 1024,
        state: "S",
        ppid: 0,
      },
    ],
  };

  it("returns the slow sample untouched until a live sample exists", () => {
    expect(mergeLive(slow, null)).toBe(slow);
    expect(mergeLive(null, live)).toBeNull();
  });

  it("refreshes composition counters while preserving slow hardware metadata", () => {
    const details = {
      semantics: "linux",
      availableBytes: 1,
      cachedBytes: 2,
      installedBytes: 16 * 1024 ** 3,
      committedBytes: 1234,
    } as NonNullable<ServerMetrics["memory"]["details"]>;
    const original = { ...slow, memory: { ...slow.memory, details } };
    const merged = mergeLive(original, live)!;
    expect(merged.memory.details).toEqual({
      ...details,
      availableBytes: (live.memTotalKb - live.memUsedKb) * 1024,
      cachedBytes: live.memCachedKb * 1024,
    });
    expect(original.memory.details.availableBytes).toBe(1);
    expect(mergeLive(original, { ...live, memTotalKb: 0 })!.memory).toBe(
      original.memory,
    );
  });

  it("overlays cpu, per-core, memory, network and processes but keeps disk", () => {
    const m = mergeLive(slow, live)!;
    expect(m.cpu).toMatchObject({
      percent: 42,
      perCore: [80, 5],
      coreIds: ["0", "2"],
      load: [1, 2, 3],
    });
    expect(m.memory).toEqual({
      percent: 50,
      usedGiB: 1,
      totalGiB: 2,
      cachedGiB: 0.5,
      freeGiB: 0.25,
    });
    expect(m.cpu.mix).toEqual(live.cpuMix);
    expect(m.network?.interfaces?.[0]).toMatchObject({
      rxRateBps: 10,
      txRateBps: 20,
    });
    expect(m.processes?.top?.[0]).toMatchObject({
      pid: "1",
      state: "S",
      ppid: "0",
      cpu: "1.5",
      mem: "50.0",
    });
    expect(m.disk).toBe(slow.disk);
  });
});
