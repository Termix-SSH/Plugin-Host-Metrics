import { describe, it, expect } from "vitest";
import { liveCmd, parseLive } from "../../../src/backend/managers/live.js";

// user/idle ticks for the aggregate and cpu0, rx bytes, uptime, then process lines.
const out = (
  agg: [number, number],
  core: [number, number],
  rx: number,
  up: number,
  procs: string,
  page = "4096",
) =>
  [
    `cpu  ${agg[0]} 0 0 ${agg[1]} 0 0 0 0 0 0\ncpu0 ${core[0]} 0 0 ${core[1]} 0 0 0 0 0 0`,
    "MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB",
    `0.1 0.2 0.3 1/2 3\n${up} 5`,
    `Inter-|\n eth0: ${rx} 0 0 0 0 0 0 0 ${rx * 2} 0\n lo: 9 0 0 0 0 0 0 0 9 0`,
    page,
    procs,
  ].join("\n@@\n");

const proc = (pid: number, ticks: number, start: number, name = "java") =>
  `${pid}\t${ticks}\t10\t${start}\tR\t1\t${name}\n`;

describe("parseLive extras", () => {
  it("reports state, parent, CPU mix, cache and the running count", () => {
    const mk = (user: number, sys: number, wait: number, idle: number) =>
      out([user, idle], [user, idle], 1, 10, procs).replace(
        /cpu  \d+ 0 0 \d+ 0 0 0 0/,
        `cpu  ${user} 0 ${sys} ${idle} ${wait} 0 0 0`,
      );
    const procs = "5\t1\t10\t7\tR\t2\tjava\n6\t1\t10\t8\tS\t5\tsh\n";
    const a = parseLive(mk(0, 0, 0, 0), undefined, 0);
    const b = parseLive(mk(30, 10, 10, 50), a.next, 1000);
    expect(b.sample.cpuMix).toMatchObject({ user: 30, system: 10, iowait: 10 });
    expect(b.sample.running).toBe(1);
    expect(b.sample.procs.find((p) => p.pid === 6)).toMatchObject({
      state: "S",
      ppid: 5,
    });
    expect(b.sample.memCachedKb).toBe(0);
  });
});

describe("liveCmd", () => {
  it("asks for the page size once, then passes the cached number", () => {
    expect(liveCmd()).toContain('pg="$(getconf PAGESIZE)"');
    expect(liveCmd(16384)).toContain("pg=16384 ");
    expect(liveCmd(16384)).not.toContain("getconf");
  });
});

describe("parseLive", () => {
  it("has no rates on the first sample", () => {
    const { sample } = parseLive(
      out([100, 100], [100, 100], 1000, 10, proc(7, 0, 1)),
      undefined,
    );
    expect(sample.cpu).toBeNull();
    expect(sample.net[0].rxBps).toBeNull();
    expect(sample.memUsedKb).toBe(600);
  });

  it("derives cpu, per-core, net and process rates from the delta", () => {
    const a = parseLive(
      out([100, 100], [100, 100], 1000, 10, proc(7, 0, 1)),
      undefined,
    );
    // aggregate: +50 busy, +50 idle; core 0: +25 busy, +75 idle
    const { sample } = parseLive(
      out([150, 150], [125, 175], 3000, 11, proc(7, 50, 1)),
      a.next,
    );
    expect(sample.cpu).toBeCloseTo(50, 0);
    expect(sample.cores[0]).toBeCloseTo(25, 0);
    expect(sample.net).toEqual([{ name: "eth0", rxBps: 2000, txBps: 4000 }]);
    expect(sample.procs[0]).toMatchObject({ pid: 7, name: "java", memKb: 40 });
    expect(sample.procs[0].cpu).toBeCloseTo(50, 0);
  });

  it("does not charge a reused pid with the old process's ticks", () => {
    const a = parseLive(
      out([100, 100], [100, 100], 1000, 10, proc(7, 5, 1)),
      undefined,
    );
    // same pid, new start time, lower ticks must not look like a huge delta
    const { sample } = parseLive(
      out([150, 150], [125, 175], 3000, 11, proc(7, 9000, 2)),
      a.next,
    );
    expect(sample.procs[0].cpu).toBe(0);
  });

  it("keeps the cached page size when a run omits it, and keeps names with tabs", () => {
    const a = parseLive(
      out([1, 1], [1, 1], 1, 10, proc(1, 0, 1), "16384"),
      undefined,
    );
    expect(a.next.pageBytes).toBe(16384);
    const b = parseLive(
      out([2, 2], [2, 2], 2, 11, proc(1, 0, 1, "a	b"), ""),
      a.next,
    );
    expect(b.next.pageBytes).toBe(16384);
    expect(b.sample.procs[0]).toMatchObject({ name: "a\tb", memKb: 160 });
  });

  it("starts rates again after a reboot", () => {
    const a = parseLive(
      out([100, 100], [100, 100], 5000, 900, proc(7, 0, 1)),
      undefined,
    );
    const { sample } = parseLive(
      out([10, 10], [10, 10], 20, 5, proc(7, 0, 1)),
      a.next,
    );
    expect(sample.cpu).toBeNull();
    expect(sample.net[0].rxBps).toBeNull();
  });
});
