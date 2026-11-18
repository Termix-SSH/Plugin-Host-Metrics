import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  DashboardHealth,
  HostMetricsApi,
} from "../../src/frontend/host-metrics-api";

const summary = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  usePermission: () => true,
}));
vi.mock("../../src/frontend/summary-store", () => ({
  useMetricsSummary: (_store: unknown, hostId: number | null) =>
    hostId ? summary.value : null,
}));

import { createHealthSummaryStore } from "../../src/frontend/health-summary";
import {
  createDashboardBadgeValue,
  createDashboardRowValue,
} from "../../src/frontend/SummaryViews";
import type { MetricsSummaryStore } from "../../src/frontend/summary-store";

afterEach(() => {
  cleanup();
  summary.value = null;
});

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const failing: DashboardHealth = {
  hostId: 7,
  level: "crit",
  checks: [
    { id: "disk", name: "Audit log", level: "crit", detail: "95%", ts: "" },
    { id: "auditd", name: "auditd", level: "ok", detail: "active", ts: "" },
  ],
};

const metricsHost = {
  id: 7,
  enableSsh: true,
  pluginSettings: { "host-metrics": { enabled: true } },
};

function setup(rows: DashboardHealth[]) {
  const api = { healthSummary: vi.fn(async () => rows) };
  const health = createHealthSummaryStore(api as unknown as HostMetricsApi);
  const metrics = {
    watch: () => () => {},
    get: () => null,
  } as unknown as MetricsSummaryStore;
  return {
    api,
    useRow: createDashboardRowValue(metrics, health),
    useBadge: createDashboardBadgeValue(health),
  };
}

describe("dashboard host row values", () => {
  it("gives check results as stats and a failing badge", async () => {
    const { useRow, useBadge, api } = setup([failing]);
    const row = renderHook(() =>
      useRow({ hostId: 7, host: { id: 7 }, online: true }),
    );
    const badge = renderHook(() => useBadge({ hostId: 7, online: true }));
    await flush();
    expect(api.healthSummary).toHaveBeenCalledOnce();
    const [stats] = row.result.current as Array<Record<string, unknown>>;
    expect(stats).toEqual({
      shape: "stat",
      items: [
        {
          label: "Audit log",
          value: "95%",
          tone: "bad",
          tooltip: "Audit log: 95%",
        },
        {
          label: "auditd",
          value: "active",
          tone: "default",
          tooltip: "auditd: active",
        },
      ],
    });
    expect(badge.result.current).toEqual({
      shape: "badge",
      label: "hostMetrics.health.failing",
      tone: "bad",
      tooltip: "Audit log: 95%",
    });
  });

  it("gives a warning badge for a check past its warn limit", async () => {
    const { useBadge } = setup([{ ...failing, level: "warn" }]);
    const badge = renderHook(() => useBadge({ hostId: 7, online: true }));
    await flush();
    expect(badge.result.current).toMatchObject({
      label: "hostMetrics.health.warning",
      tone: "warn",
    });
  });

  it("leaves the layout's badge when checks pass, or the host is offline", async () => {
    const { useBadge } = setup([
      { ...failing, hostId: 8, level: "ok" },
      failing,
    ]);
    const passing = renderHook(() => useBadge({ hostId: 8, online: true }));
    const offline = renderHook(() => useBadge({ hostId: 7, online: false }));
    const none = renderHook(() => useBadge({ hostId: 9, online: true }));
    await flush();
    expect(passing.result.current).toBeNull();
    expect(offline.result.current).toBeNull();
    expect(none.result.current).toBeNull();
  });

  it("caps the checks shown in a row and counts the rest", async () => {
    const checks = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      name: id,
      level: "ok" as const,
      detail: "1",
      ts: "",
    }));
    const { useRow } = setup([{ hostId: 7, level: "ok", checks }]);
    const row = renderHook(() =>
      useRow({ hostId: 7, host: { id: 7 }, online: true }),
    );
    await flush();
    const [stats, more] = row.result.current as Array<{
      items?: unknown[];
      text?: string;
    }>;
    expect(stats.items).toHaveLength(3);
    expect(more).toEqual({ shape: "text", text: "+2" });
  });

  it("gives usage bars as shares, and keeps their places while unknown", async () => {
    const { useRow } = setup([]);
    const loading = renderHook(() =>
      useRow({ hostId: 7, host: metricsHost, online: true }),
    );
    await flush();
    expect(loading.result.current).toEqual([
      {
        shape: "bars",
        items: [
          { label: "dashboard.cpu", value: null },
          { label: "dashboard.ram", value: null },
          { label: "dashboardTab.disk", value: null },
        ],
      },
    ]);
    summary.value = {
      cpu: { percent: 42 },
      memory: { percent: 75 },
      disk: { percent: null },
    };
    const live = renderHook(() =>
      useRow({ hostId: 7, host: metricsHost, online: true }),
    );
    await flush();
    expect(live.result.current).toEqual([
      {
        shape: "bars",
        items: [
          { label: "dashboard.cpu", value: 0.42 },
          { label: "dashboard.ram", value: 0.75 },
        ],
      },
    ]);
  });

  it("fetches once for many rows and stops when none are shown", async () => {
    vi.useFakeTimers();
    const { useBadge, api } = setup([failing]);
    const a = renderHook(() => useBadge({ hostId: 7, online: true }));
    const b = renderHook(() => useBadge({ hostId: 8, online: true }));
    expect(api.healthSummary).toHaveBeenCalledOnce();
    a.unmount();
    b.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.healthSummary).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
