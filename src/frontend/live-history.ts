import type { ServerMetrics } from "../shared/metrics.js";
import type { MetricCardHistories } from "./cards";

/** About two minutes at the default 2 s live interval. */
export const LIVE_POINTS = 60;

export function emptyHistories(): MetricCardHistories {
  return { cpu: [], memory: [], swap: [], disk: [], ts: [], gpu: {} };
}

/**
 * Adds one reading to the live charts. A reading at the same time as the
 * last one (the slow sample and a live one landing together) replaces it.
 */
export function pushLive(
  prev: MetricCardHistories,
  data: ServerMetrics,
  at: number = Date.now(),
  max = LIVE_POINTS,
): MetricCardHistories {
  const stamp = new Date(at).toISOString();
  const same = prev.ts.length > 0 && prev.ts[prev.ts.length - 1] === stamp;
  const add = <T>(arr: T[], value: T) =>
    [...(same ? arr.slice(0, -1) : arr), value].slice(-max);
  return {
    ...prev,
    cpu: add(prev.cpu, data.cpu?.percent ?? null),
    memory: add(prev.memory, data.memory?.percent ?? null),
    swap: add(prev.swap ?? [], data.swap?.percent ?? null),
    disk: add(prev.disk, data.disk?.percent ?? null),
    ts: add(prev.ts, stamp),
  };
}
