import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type {
  DashboardHealth,
  HostMetricsApi,
} from "../../src/frontend/host-metrics-api";

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  usePermission: () => true,
}));
vi.mock("../../src/frontend/summary-store", () => ({
  useMetricsSummary: () => null,
}));

import { createHealthSummaryStore } from "../../src/frontend/health-summary";
import {
  createDashboardHealthBadge,
  createDashboardHostMetrics,
} from "../../src/frontend/SummaryViews";
import type { MetricsSummaryStore } from "../../src/frontend/summary-store";

afterEach(cleanup);

const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

const failing: DashboardHealth = {
  hostId: 7,
  level: "crit",
  checks: [
    { id: "disk", name: "Audit log", level: "crit", detail: "95%", ts: "" },
    { id: "auditd", name: "auditd", level: "ok", detail: "active", ts: "" },
  ],
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
    health,
    Row: createDashboardHostMetrics(metrics, health),
    Badge: createDashboardHealthBadge(health),
  };
}

describe("dashboard health checks", () => {
  it("shows check results in the host row and a failing badge", async () => {
    const { Row, Badge, api } = setup([failing]);
    render(
      <>
        <Row hostId={7} host={{ id: 7 }} online />
        <Badge hostId={7} online fallback={<span>Online</span>} />
      </>,
    );
    await flush();
    expect(api.healthSummary).toHaveBeenCalledOnce();
    expect(screen.getByText("Audit log")).toBeInTheDocument();
    expect(screen.getByText("95%")).toHaveClass("text-red-400");
    expect(screen.getByText("active")).toHaveClass("text-accent-brand");
    expect(screen.getByText("hostMetrics.health.failing")).toHaveAttribute(
      "title",
      "Audit log: 95%",
    );
    expect(screen.queryByText("Online")).toBeNull();
  });

  it("shows a warning badge for a check past its warn limit", async () => {
    const { Badge } = setup([{ ...failing, level: "warn" }]);
    render(<Badge hostId={7} online fallback={<span>Online</span>} />);
    await flush();
    expect(screen.getByText("hostMetrics.health.warning")).toBeInTheDocument();
  });

  it("keeps the layout's badge when checks pass, or the host is offline", async () => {
    const { Badge } = setup([{ ...failing, hostId: 8, level: "ok" }, failing]);
    render(
      <>
        <Badge hostId={8} online fallback={<span>Passing</span>} />
        <Badge hostId={7} online={false} fallback={<span>Offline</span>} />
        <Badge hostId={9} online fallback={<span>No checks</span>} />
      </>,
    );
    await flush();
    expect(screen.getByText("Passing")).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(screen.getByText("No checks")).toBeInTheDocument();
  });

  it("caps the checks shown in a row", async () => {
    const checks = ["a", "b", "c", "d", "e"].map((id) => ({
      id,
      name: id,
      level: "ok" as const,
      detail: "1",
      ts: "",
    }));
    const { Row } = setup([{ hostId: 7, level: "ok", checks }]);
    render(<Row hostId={7} host={{ id: 7 }} online />);
    await flush();
    expect(document.querySelectorAll("[data-hm-health-check]")).toHaveLength(3);
    expect(screen.getByText("+2")).toBeInTheDocument();
  });

  it("fetches once for many rows and stops when none are shown", async () => {
    vi.useFakeTimers();
    const { Badge, api } = setup([failing]);
    const view = render(
      <>
        <Badge hostId={7} online fallback={null} />
        <Badge hostId={8} online fallback={null} />
      </>,
    );
    expect(api.healthSummary).toHaveBeenCalledOnce();
    view.unmount();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.healthSummary).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
