import { useEffect, useState } from "react";
import type { LiveSample, ServerMetrics } from "../shared/metrics.js";
import type { MetricCardHistories } from "./cards";
import type { HostMetricsApi } from "./host-metrics-api";
import { mergeLive } from "./live-metrics";
import { emptyHistories, pushLive } from "./live-history";

export type FeedState = "loading" | "ok" | "totp" | "failed";

interface Feed {
  users: number;
  full: ServerMetrics | null;
  live: LiveSample | null;
  metrics: ServerMetrics | null;
  histories: MetricCardHistories;
  state: FeedState;
  listeners: Set<() => void>;
  stop: () => void;
}

const feeds = new Map<number, Feed>();
const LIVE_RETRY_MS = 30_000;

function notify(feed: Feed) {
  for (const listener of feed.listeners) listener();
}

function start(
  api: HostMetricsApi,
  hostId: number,
  intervalMs: number,
  liveMs: number | null,
): Feed {
  const feed: Feed = {
    users: 0,
    full: null,
    live: null,
    metrics: null,
    histories: emptyHistories(),
    state: "loading",
    listeners: new Set(),
    stop: () => {},
  };
  let cancelled = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let viewer: string | undefined;

  // The same reading the Host Metrics tab shows: the slow full sample with
  // the fast live one laid over it. CPU % only comes from the live one.
  const publish = (state: FeedState) => {
    if (cancelled) return;
    feed.metrics = mergeLive(feed.full, feed.live);
    if (feed.metrics) feed.histories = pushLive(feed.histories, feed.metrics);
    feed.state = state;
    notify(feed);
  };
  const refresh = async () => {
    try {
      const data = await api.getMetrics(hostId);
      if (data) {
        feed.full = data;
        publish("ok");
      }
    } catch {
      if (!feed.full) publish("failed");
    }
  };
  const tickLive = async () => {
    if (cancelled || liveMs == null) return;
    let delay = liveMs;
    if (!document.hidden && feed.full) {
      try {
        const sample = await api.managerGet<
          LiveSample & { pending?: boolean; minIntervalS?: number }
        >(hostId, "live", { stream: 1, nowait: 1, ms: liveMs });
        if (cancelled) return;
        if (!sample.pending) {
          feed.live = sample;
          publish("ok");
        }
        delay = Math.max(liveMs, (sample.minIntervalS ?? 0) * 1000);
      } catch {
        if (cancelled) return;
        // Off for this host or not Linux: the slow sample carries on alone.
        feed.live = null;
        delay = LIVE_RETRY_MS;
      }
    }
    liveTimer = setTimeout(() => void tickLive(), delay);
  };

  void (async () => {
    try {
      const started = await api.startMetrics(hostId);
      if (cancelled) return;
      if (started.requires_totp) return publish("totp");
      viewer = started.viewerSessionId;
      for (let i = 0; i < 6 && !cancelled; i++) {
        const data = await api.getMetrics(hostId);
        if (data) {
          feed.full = data;
          publish("ok");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (cancelled) return;
      timer = setInterval(() => void refresh(), intervalMs);
      beat = setInterval(() => {
        if (viewer) api.heartbeat(viewer).catch(() => {});
      }, 30000);
      void tickLive();
    } catch {
      publish("failed");
    }
  })();
  feed.stop = () => {
    cancelled = true;
    if (timer) clearInterval(timer);
    if (beat) clearInterval(beat);
    if (liveTimer) clearTimeout(liveTimer);
    api.stopMetrics(hostId, viewer).catch(() => {});
  };
  return feed;
}

/**
 * Live metrics for one host, collected once however many tiles show them.
 * Collection starts with the first visible tile and stops with the last.
 */
export function useMetricsFeed(
  api: HostMetricsApi,
  hostId: number | null,
  active: boolean,
  intervalMs: number,
  liveMs: number | null = null,
): {
  metrics: ServerMetrics | null;
  histories: MetricCardHistories;
  state: FeedState;
} {
  const [, setTick] = useState(0);
  const feed = hostId != null ? feeds.get(hostId) : undefined;

  useEffect(() => {
    if (!active || hostId == null) return;
    let current = feeds.get(hostId);
    if (!current) {
      current = start(api, hostId, intervalMs, liveMs);
      feeds.set(hostId, current);
    }
    current.users++;
    const listener = () => setTick((n) => n + 1);
    current.listeners.add(listener);
    setTick((n) => n + 1);
    const held = current;
    return () => {
      held.listeners.delete(listener);
      held.users--;
      if (held.users <= 0) {
        held.stop();
        if (feeds.get(hostId) === held) feeds.delete(hostId);
      }
    };
  }, [api, hostId, active, intervalMs, liveMs]);

  return {
    metrics: feed?.metrics ?? null,
    histories: feed?.histories ?? EMPTY,
    state: feed?.state ?? "loading",
  };
}

const EMPTY = emptyHistories();

/** Test seam. */
export function resetMetricsFeeds(): void {
  for (const feed of feeds.values()) feed.stop();
  feeds.clear();
}
