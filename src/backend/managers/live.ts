import { execCommand } from "@termix-ssh/plugin-sdk/host-commands";
import type { RequestHandler, Router } from "express";
import type { LiveSample } from "../../shared/metrics.js";
import { parseCpuLine } from "../widgets/cpu-collector.js";
import { managerHandler } from "./route-helpers.js";
import type { ManagerRoutesDeps } from "./types.js";

// One awk reads every /proc file itself, so a sample is one exec of awk instead
// of a shell plus six tools. Output sections are split by @@; each process line
// is pid, utime+stime ticks, rss pages, starttime, state, ppid, comm.
const AWK = String.raw`BEGIN{f="/proc/stat";while((getline l<f)>0)if(l~/^cpu/)print l;close(f);print "@@";f="/proc/meminfo";while((getline l<f)>0)if(l~/^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SwapTotal|SwapFree):/)print l;close(f);print "@@";f="/proc/loadavg";getline l<f;print l;close(f);f="/proc/uptime";getline l<f;print l;close(f);print "@@";f="/proc/net/dev";while((getline l<f)>0)print l;close(f);print "@@";print pg;print "@@";for(i=1;i<ARGC;i++){f=ARGV[i];if((getline s<f)>0){a=index(s,"(");if(a&&match(s,/\)[^)]*$/)){split(substr(s,RSTART+2),x," ");print substr(s,1,a-2)"	"(x[12]+x[13])"	"x[22]"\t"x[20]"\t"x[1]"	"x[2]"	"substr(s,a+1,RSTART-a-1)}}close(f)}}`;

// The page size never changes on a host, so it is asked once and then passed in.
export const liveCmd = (pageBytes?: number) =>
  "awk -v pg=" +
  (pageBytes ?? '"$(getconf PAGESIZE)"') +
  " '" +
  AWK +
  "' /proc/[0-9]*/stat";

/** What the next call needs from this one. */
export interface LivePrev {
  at: number;
  uptime: number;
  pageBytes: number;
  cpu: Map<string, { total: number; idle: number }>;
  /** Aggregate user nice system idle iowait irq softirq steal ticks, for the breakdown. */
  cpuRaw?: number[];
  /** Keyed by pid:starttime so a reused pid never inherits another process's ticks. */
  ticks: Map<string, number>;
  net: Map<string, { rx: number; tx: number }>;
}

const TOP_N = 60;

export function parseLive(
  output: string,
  prev: LivePrev | undefined,
  at = Date.now(),
): { sample: LiveSample; next: LivePrev } {
  const [cpuS = "", memS = "", loadS = "", netS = "", pageS = "", procS = ""] =
    output.split("@@\n");

  // Only the first 8 fields: guest and guest_nice are already inside user and nice.
  const cpu = new Map<string, { total: number; idle: number }>();
  let cpuRaw: number[] | undefined;
  for (const l of cpuS.split("\n")) {
    const name = l.split(/\s+/)[0];
    if (!name.startsWith("cpu")) continue;
    if (name === "cpu") cpuRaw = l.split(/\s+/).slice(1, 9).map(Number);
    const c = parseCpuLine(
      l
        .replace(/^cpu\d*/, "cpu")
        .split(/\s+/)
        .slice(0, 9)
        .join(" "),
    );
    if (c) cpu.set(name, c);
  }
  // Matched by name, so an offline core does not shift the ones after it.
  const pct = (name: string) => {
    const p = prev?.cpu.get(name);
    const c = cpu.get(name);
    if (!p || !c || c.total <= p.total) return null;
    const used = c.total - p.total - (c.idle - p.idle);
    return Math.max(0, Math.min(100, (used / (c.total - p.total)) * 100));
  };

  // Where the busy time went since the last sample, as percent of all ticks.
  let cpuMix: LiveSample["cpuMix"];
  if (prev?.cpuRaw && cpuRaw && cpuRaw.length === 8) {
    const d = cpuRaw.map((v, i) => v - (prev.cpuRaw?.[i] ?? 0));
    const total = d.reduce((a, b) => a + b, 0);
    if (total > 0 && d.every((v) => v >= 0)) {
      const p = (n: number) => (n / total) * 100;
      cpuMix = {
        user: p(d[0] + d[1]),
        system: p(d[2] + d[5] + d[6]),
        iowait: p(d[4]),
        steal: p(d[7]),
      };
    }
  }

  const mem: Record<string, number> = {};
  for (const l of memS.split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]);
  }

  const [la = "", up = ""] = loadS.trim().split("\n");
  const laParts = la.split(/\s+/).map(Number);
  const uptime = Number(up.split(/\s+/)[0]) || 0;

  const nets = new Map<string, { rx: number; tx: number }>();
  for (const l of netS.split("\n")) {
    const [name, rest] = l.split(":");
    if (!rest || name.trim() === "lo") continue;
    const f = rest.trim().split(/\s+/);
    nets.set(name.trim(), { rx: Number(f[0]) || 0, tx: Number(f[8]) || 0 });
  }
  // A reboot makes uptime go backwards, so rates start again.
  const dt = prev && uptime > prev.uptime ? uptime - prev.uptime : 0;
  const rate = (now: number, before: number | undefined) =>
    dt > 0 && before !== undefined && now >= before
      ? (now - before) / dt
      : null;

  const pageBytes = Number(pageS.trim()) || prev?.pageBytes || 4096;
  const pageKb = pageBytes / 1024;
  const aggDelta =
    prev && cpu.has("cpu") && prev.cpu.has("cpu")
      ? cpu.get("cpu")!.total - prev.cpu.get("cpu")!.total
      : 0;
  const cores = [...cpu.keys()].filter((k) => k !== "cpu");
  const ncpu = Math.max(1, cores.length);
  const ticks = new Map<string, number>();
  const procs: LiveSample["procs"] = [];
  for (const l of procS.split("\n")) {
    const [pid, t, rss, start, state, ppid, ...rest] = l.split("	");
    const name = rest.join("\t");
    if (!name) continue;
    const key = pid + ":" + start;
    const tk = Number(t) || 0;
    ticks.set(key, tk);
    const before = prev?.ticks.get(key);
    procs.push({
      pid: Number(pid),
      name,
      cpu:
        before !== undefined && aggDelta > 0 && tk >= before
          ? ((tk - before) / aggDelta) * ncpu * 100
          : 0,
      memKb: (Number(rss) || 0) * pageKb,
      state: state || "?",
      ppid: Number(ppid) || 0,
    });
  }
  procs.sort((a, b) => b.cpu - a.cpu || b.memKb - a.memKb);

  // Awk exits 0 when /proc is missing (macOS, restricted containers); that is not a sample.
  if (!cpu.has("cpu") || !mem.MemTotal || !uptime) {
    throw new Error("live sample unavailable: /proc data missing");
  }
  const memTotalKb = mem.MemTotal;
  const swapTotalKb = mem.SwapTotal ?? 0;
  return {
    sample: {
      cpu: pct("cpu"),
      cores: cores.map(pct),
      coreIds: cores.map((k) => k.slice(3)),
      cpuMix,
      memTotalKb,
      memCachedKb: (mem.Buffers ?? 0) + (mem.Cached ?? 0),
      memFreeKb: mem.MemFree ?? 0,
      memUsedKb: memTotalKb - (mem.MemAvailable ?? 0),
      swapTotalKb,
      swapUsedKb: swapTotalKb - (mem.SwapFree ?? 0),
      load: [laParts[0] || 0, laParts[1] || 0, laParts[2] || 0],
      net: [...nets].map(([name, c]) => ({
        name,
        rxBps: rate(c.rx, prev?.net.get(name)?.rx),
        txBps: rate(c.tx, prev?.net.get(name)?.tx),
      })),
      count: procs.length,
      running: procs.filter((p) => p.state === "R").length,
      procs: procs.slice(0, TOP_N),
    },
    next: { at, uptime, pageBytes, cpu, cpuRaw, ticks, net: nets },
  };
}

const STALE_MS = 60_000;

export function registerLiveRoutes(app: Router, deps: ManagerRoutesDeps): void {
  const { validateHostId, liveConfig } = deps;
  // One baseline and one in-flight/recent sample per host, shared by every user
  // and tab, so the host sees at most one exec per admin minimum interval.
  // shortcut: samples are host-level data and the access check runs first;
  // add a per-user key if per-user visibility is ever introduced.
  const prevs = new Map<number, LivePrev>();
  const recent = new Map<
    number,
    { at: number; minMs: number; pending: boolean; sample: Promise<LiveSample> }
  >();

  /** Stops disabled hosts before an SSH connection is borrowed. */
  const gate: RequestHandler = async (req, res, next) => {
    try {
      const config = await liveConfig(parseInt(String(req.params.id), 10));
      if (!config.enabled) {
        res
          .status(403)
          .json({ error: "Live updates are disabled", code: "LIVE_DISABLED" });
        return;
      }
      res.locals.liveMinMs = config.minSeconds * 1000;
      next();
    } catch (error) {
      next(error);
    }
  };

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/live/{id}:
   *   get:
   *     summary: Lightweight live CPU, memory, network and process sample (Linux)
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: One live sample, shared per host and reused until the admin minimum interval passes. Includes minIntervalS. }
   *       403: { description: No access, or live updates are disabled (code LIVE_DISABLED). }
   */
  app.get(
    "/host-metrics/managers/live/:id",
    validateHostId,
    gate,
    managerHandler(
      deps,
      "connect",
      "live_sample",
      async (client, host, req) => {
        const minMs: number = req.res?.locals.liveMinMs;
        const now = Date.now();
        // Entries live past their own minimum, so a long minimum is never cut short.
        for (const [k, v] of recent)
          if (!v.pending && now - v.at > Math.max(STALE_MS, v.minMs * 2)) {
            recent.delete(k);
            prevs.delete(k);
          }
        const hit = recent.get(host.id);
        // A running sample is always joined. Failures are reused too, which
        // backs a failing host off to the same pace.
        // The current policy is applied on the way out so a raised minimum reaches clients at once.
        const withPolicy = (p: Promise<LiveSample>) =>
          p.then((s) => ({ ...s, minIntervalS: minMs / 1000 }));
        if (hit && (hit.pending || now - hit.at < minMs)) {
          return withPolicy(hit.sample);
        }

        const before = prevs.get(host.id);
        const sample = (async () => {
          const { stdout, code } = await execCommand(
            client,
            liveCmd(before?.pageBytes),
            5000,
          );
          // A failed run must not replace the baseline with garbage.
          if (code !== 0) throw new Error("live sample failed");
          const parsed = parseLive(stdout, before, now);
          prevs.set(host.id, parsed.next);
          return parsed.sample;
        })();
        const entry = { at: now, minMs, pending: true, sample };
        recent.set(host.id, entry);
        const settle = () => {
          entry.pending = false;
        };
        sample.then(settle, settle);
        return withPolicy(sample);
      },
    ),
  );
}
