import { useEffect, useState } from "react";
import type { LiveSample, ServerMetrics } from "../shared/metrics.js";
import { useHostMetricsApi } from "./host-metrics-api";

const DEFAULT_POLL_MS = 2000;
// shortcut: Linux only; a host that errors this many times in a row (Windows,
// macOS) or has live updates disabled keeps the slow poll and is only retried
// at this pace, so re-enabling or recovery needs no remount.
const MAX_ERRORS = 3;
const RETRY_MS = 30_000;

/** The liveInterval user setting in ms, null for "off", 2s for anything unknown. */
export function liveIntervalMs(value: unknown): number | null {
  if (value === "off") return null;
  if (value === "1") return 1000;
  if (value === "5") return 5000;
  return DEFAULT_POLL_MS;
}

/** The backgroundGraceS user setting in ms: how long a hidden page keeps its connection. Default 10s. */
export function backgroundGraceMs(value: unknown): number {
  const s = Number(value);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 10_000;
}

/** Overlays the 1s live sample on the slow full sample. */
/** htop's memory split: free, cache, and used as the rest. They never overlap and sum to 100. */
export function memParts(totalKb: number, freeKb: number, cachedKb: number) {
  if (!totalKb) return null;
  const free = Math.min(Math.max(freeKb, 0), totalKb);
  const cache = Math.min(Math.max(cachedKb, 0), totalKb - free);
  const pct = (kb: number) => (kb / totalKb) * 100;
  return {
    used: pct(totalKb - free - cache),
    cache: pct(cache),
    free: pct(free),
  };
}

/** Overlays the 1s live sample on the slow full sample. */
export function mergeLive(
  m: ServerMetrics | null,
  l: LiveSample | null,
): ServerMetrics | null {
  if (!m || !l) return m;
  const gib = (kb: number) => Math.round((kb / 1024 / 1024) * 100) / 100;
  const memTotal = l.memTotalKb;
  return {
    ...m,
    cpu: {
      ...m.cpu,
      percent: l.cpu == null ? m.cpu.percent : Math.round(l.cpu),
      load: l.load,
      perCore: l.cores,
      coreIds: l.coreIds,
      mix: l.cpuMix,
    },
    memory: memTotal
      ? {
          ...m.memory,
          percent: Math.round((l.memUsedKb / memTotal) * 100),
          usedGiB: gib(l.memUsedKb),
          totalGiB: gib(memTotal),
          cachedGiB: gib(l.memCachedKb),
          freeGiB: gib(l.memFreeKb),
          ...(m.memory.details && {
            details: {
              ...m.memory.details,
              availableBytes: Math.max(0, memTotal - l.memUsedKb) * 1024,
              cachedBytes: l.memCachedKb * 1024,
            },
          }),
        }
      : m.memory,
    network: m.network && {
      ...m.network,
      interfaces: m.network.interfaces?.map((i) => {
        const n = l.net.find((x) => x.name === i.name);
        return n ? { ...i, rxRateBps: n.rxBps, txRateBps: n.txBps } : i;
      }),
    },
    processes: {
      ...m.processes,
      total: l.count,
      running: l.running,
      top: l.procs.map((p) => ({
        pid: String(p.pid),
        state: p.state,
        ppid: String(p.ppid),
        user: "",
        cpu: p.cpu.toFixed(1),
        mem: memTotal ? ((p.memKb / memTotal) * 100).toFixed(1) : "0",
        command: p.name,
      })),
    },
  };
}

/**
 * Polls the cheap live endpoint every second while active. Requests never
 * overlap, and nothing runs while the tab is hidden or inactive.
 */
export function useLiveMetrics(
  hostId: number | null,
  active: boolean,
  intervalMs: number | null,
): LiveSample | null {
  const { managerGet } = useHostMetricsApi();
  const [live, setLive] = useState<{
    hostId: number;
    sample: LiveSample;
  } | null>(null);

  useEffect(() => {
    if (hostId == null || !active || intervalMs == null) return;
    let stopped = false;
    let errors = 0;
    let delay = intervalMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!document.hidden) {
        try {
          const sample = await managerGet<LiveSample>(hostId, "live");
          if (stopped) return;
          errors = 0;
          setLive({ hostId, sample });
          // The admin minimum wins over a faster user choice.
          delay = Math.max(intervalMs, (sample.minIntervalS ?? 0) * 1000);
        } catch (error) {
          if (stopped) return;
          // Drop the stale overlay so the cards fall back to the slow sample.
          setLive(null);
          const data = (error as { response?: { data?: { code?: string } } })
            ?.response?.data;
          delay =
            data?.code === "LIVE_DISABLED" || ++errors >= MAX_ERRORS
              ? Math.max(intervalMs, RETRY_MS)
              : intervalMs;
        }
      }
      timer = setTimeout(tick, delay);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
      setLive(null);
    };
  }, [hostId, active, intervalMs, managerGet]);

  return active && intervalMs != null && live?.hostId === hostId
    ? live.sample
    : null;
}
