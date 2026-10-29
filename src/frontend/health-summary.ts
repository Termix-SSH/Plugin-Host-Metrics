import { useCallback, useSyncExternalStore } from "react";
import type { DashboardHealth, HostMetricsApi } from "./host-metrics-api";

const REFRESH_MS = 60_000;

/**
 * Stored health check results for the dashboard rows, read in one request
 * for every host while any row shows them. Never runs a check itself.
 */
export function createHealthSummaryStore(api: HostMetricsApi) {
  let data = new Map<number, DashboardHealth>();
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let loading: Promise<void> | null = null;

  function refresh(): Promise<void> {
    loading ??= api
      .healthSummary()
      .then((rows) => {
        data = new Map(rows.map((row) => [row.hostId, row]));
        for (const listener of listeners) listener();
      })
      .catch(() => {
        // Keep the last result; the next tick tries again.
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      if (!timer) {
        void refresh();
        timer = setInterval(() => {
          if (typeof document === "undefined" || !document.hidden)
            void refresh();
        }, REFRESH_MS);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) stop();
      };
    },
    get(hostId: number): DashboardHealth | null {
      return data.get(hostId) ?? null;
    },
    refresh,
    dispose() {
      listeners.clear();
      stop();
    },
  };
}

export type HealthSummaryStore = ReturnType<typeof createHealthSummaryStore>;

export function useDashboardHealth(
  store: HealthSummaryStore,
  hostId: number | null,
): DashboardHealth | null {
  const subscribe = useCallback(
    (onChange: () => void) => (hostId ? store.subscribe(onChange) : () => {}),
    [store, hostId],
  );
  return useSyncExternalStore(
    subscribe,
    () => (hostId ? store.get(hostId) : null),
    () => null,
  );
}
