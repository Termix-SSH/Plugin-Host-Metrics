import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useSettings } from "@termix-ssh/plugin-sdk/frontend";
import type { ServerMetrics } from "../shared/metrics.js";
import type { HostMetricsApi } from "./host-metrics-api";
import { liveIntervalMs, mergeLive, useLiveMetrics } from "./live-metrics";

const REFRESH_MS = 30_000;
// A dashboard can list many hosts, so its rows follow the live sample more slowly than the tab does.
const SUMMARY_LIVE_MIN_MS = 5_000;
// Each live row holds an SSH connection, so the rest stay on the 30 second sample.
const SUMMARY_LIVE_MAX_HOSTS = 6;

interface Entry {
  refs: number;
  viewerSessionId?: string;
  data: ServerMetrics | null;
  listeners: Set<() => void>;
}

/**
 * Latest metrics for hosts shown outside the tab (dashboard rows, homepage
 * widgets). Each watched host holds one viewer, so polling runs while
 * something shows it and stops with the last one.
 */
export function createMetricsSummaryStore(api: HostMetricsApi) {
  const entries = new Map<number, Entry>();
  let timer: ReturnType<typeof setInterval> | null = null;
  const liveHolders = new Set<object>();
  const liveWaiting: Array<{ holder: object; grant: () => void }> = [];

  function grantLive() {
    while (liveHolders.size < SUMMARY_LIVE_MAX_HOSTS && liveWaiting.length) {
      const next = liveWaiting.shift()!;
      liveHolders.add(next.holder);
      next.grant();
    }
  }

  const notify = (entry: Entry) => {
    for (const listener of entry.listeners) listener();
  };

  async function refresh(hostId: number): Promise<void> {
    const entry = entries.get(hostId);
    if (!entry) return;
    try {
      if (
        entry.viewerSessionId &&
        !(await api.heartbeat(entry.viewerSessionId))
      ) {
        entry.viewerSessionId = undefined;
      }
      if (!entry.viewerSessionId) {
        const registered = await api.registerViewer(hostId);
        if (registered.viewerSessionId) {
          entry.viewerSessionId = registered.viewerSessionId;
        }
      }
      entry.data = await api.getMetrics(hostId);
    } catch {
      // Keep the last value; the next tick tries again.
    }
    if (entries.get(hostId) === entry) notify(entry);
  }

  function tick() {
    if (typeof document !== "undefined" && document.hidden) return;
    for (const hostId of entries.keys()) void refresh(hostId);
  }

  function release(hostId: number, entry: Entry) {
    entries.delete(hostId);
    if (entry.viewerSessionId) {
      void api.unregisterViewer(hostId, entry.viewerSessionId).catch(() => {});
    }
    if (entries.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    watch(hostId: number, listener: () => void): () => void {
      let entry = entries.get(hostId);
      if (!entry) {
        entry = { refs: 0, data: null, listeners: new Set() };
        entries.set(hostId, entry);
        void refresh(hostId);
      }
      entry.refs++;
      entry.listeners.add(listener);
      if (!timer) timer = setInterval(tick, REFRESH_MS);
      const held = entry;
      return () => {
        held.listeners.delete(listener);
        held.refs--;
        if (held.refs <= 0) release(hostId, held);
      };
    },

    /** Asks for one of the few live slots. Calls grant when one is free. */
    claimLive(grant: () => void): () => void {
      const holder = {};
      liveWaiting.push({ holder, grant });
      grantLive();
      return () => {
        const waiting = liveWaiting.findIndex((w) => w.holder === holder);
        if (waiting >= 0) liveWaiting.splice(waiting, 1);
        if (liveHolders.delete(holder)) grantLive();
      };
    },

    get(hostId: number): ServerMetrics | null {
      return entries.get(hostId)?.data ?? null;
    },

    dispose() {
      for (const [hostId, entry] of [...entries.entries()]) {
        release(hostId, entry);
      }
    },
  };
}

export type MetricsSummaryStore = ReturnType<typeof createMetricsSummaryStore>;

/** The host's latest sample, polled while the calling component is shown. */
export function useMetricsSummary(
  store: MetricsSummaryStore,
  hostId: number | null | undefined,
  /** False when nothing shown needs live values (offline host, slow-only fields). */
  wantLive = true,
): ServerMetrics | null {
  // Stable per host, or every render would drop and re-add the viewer.
  const subscribe = useCallback(
    (onChange: () => void) =>
      hostId ? store.watch(hostId, onChange) : () => {},
    [store, hostId],
  );
  const slow = useSyncExternalStore(
    subscribe,
    () => (hostId ? store.get(hostId) : null),
    () => null,
  );
  const chosen = liveIntervalMs(useSettings("user").values.liveInterval);
  const wantsSlot = !!hostId && !!slow && wantLive && chosen != null;
  const [hasSlot, setHasSlot] = useState(false);
  useEffect(() => {
    if (!wantsSlot) return;
    const release = store.claimLive(() => setHasSlot(true));
    return () => {
      release();
      setHasSlot(false);
    };
  }, [store, wantsSlot]);
  const live = useLiveMetrics(
    hostId ?? null,
    wantsSlot && hasSlot,
    chosen == null ? null : Math.max(chosen, SUMMARY_LIVE_MIN_MS),
  );
  return mergeLive(slow, live);
}
