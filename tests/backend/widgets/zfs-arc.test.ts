import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "ssh2";
import {
  ARC_SCRIPT,
  parseArcReclaimableBytes,
  splitArc,
} from "../../../src/backend/widgets/zfs-arc.js";
import { collectMemoryMetrics } from "../../../src/backend/widgets/memory-collector.js";
import { mergeLive } from "../../../src/frontend/live-metrics.js";
import type { LiveSample, ServerMetrics } from "../../../src/shared/metrics.js";

const exec = vi.hoisted(() => vi.fn());
vi.mock("@termix-ssh/plugin-sdk/host-commands", () => ({ execCommand: exec }));
beforeEach(() => vi.clearAllMocks());

const GiB = 1024 * 1024 * 1024;
const arcstats = `13 1 0x01 123 33456 1234 5678
name                            type data
hits                            4    100
c_min                           4    ${2 * GiB}
size                            4    ${42 * GiB}
`;
const meminfo = `MemTotal:       ${64 * 1024 * 1024} kB
MemFree:        ${2 * 1024 * 1024} kB
MemAvailable:   ${5 * 1024 * 1024} kB
`;

describe("ZFS ARC", () => {
  it("checks the QNAP QuTS hero paths too", () => {
    expect(ARC_SCRIPT).toContain("/proc/spl/kstat/zfs/arcstats");
    expect(ARC_SCRIPT).toContain("/proc/lpl/kstat/zfs/arcstats");
    expect(ARC_SCRIPT).toContain("/proc/sys/kstat/zfs/misc/arcstats");
  });

  it("counts ARC above c_min as reclaimable", () => {
    expect(parseArcReclaimableBytes(arcstats)).toBe(40 * GiB);
    expect(parseArcReclaimableBytes("hits 4 1")).toBeNull();
    expect(parseArcReclaimableBytes(`size 4 10\nc_min 4 20`)).toBe(0);
  });

  it("leaves output without an ARC section alone", () => {
    expect(splitArc(meminfo)).toEqual({ rest: meminfo, arcBytes: 0 });
  });

  it("takes reclaimable ARC out of used memory", async () => {
    exec.mockResolvedValue({ stdout: `${meminfo}\n@@ARC\n${arcstats}` });
    const m = await collectMemoryMetrics({} as Client, "linux");
    expect(m.arcKb).toBe(40 * 1024 * 1024);
    expect(m.usedGiB).toBe(19);
    expect(m.percent).toBe(30);
  });

  it("never takes more than used memory", async () => {
    const tiny = `MemTotal: 1000 kB\nMemAvailable: 900 kB\n`;
    exec.mockResolvedValue({ stdout: `${tiny}\n@@ARC\nsize 4 ${GiB}` });
    const m = await collectMemoryMetrics({} as Client, "linux");
    expect(m.arcKb).toBe(100);
    expect(m.percent).toBe(0);
  });

  it("applies the slow ARC reading to live samples", () => {
    const slow = {
      cpu: { percent: 0, cores: 1, load: [0, 0, 0] },
      memory: { percent: 30, usedGiB: 19, totalGiB: 64, arcKb: 40 * 1048576 },
      disk: { percent: 0, usedHuman: null, totalHuman: null },
      lastChecked: "",
    } as unknown as ServerMetrics;
    const live = {
      cpu: 1,
      cores: [],
      coreIds: [],
      memTotalKb: 64 * 1048576,
      memUsedKb: 59 * 1048576,
      memCachedKb: 1048576,
      memFreeKb: 2 * 1048576,
      swapTotalKb: 0,
      swapUsedKb: 0,
      load: [0, 0, 0],
      net: [],
      count: 0,
      running: 0,
      procs: [],
    } as unknown as LiveSample;
    const merged = mergeLive(slow, live)!;
    expect(merged.memory.usedGiB).toBe(19);
    expect(merged.memory.cachedGiB).toBe(41);
  });
});
