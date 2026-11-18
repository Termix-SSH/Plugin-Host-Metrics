import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";

const summary = vi.hoisted(() => ({ value: null as unknown }));

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  usePermission: () => true,
}));
vi.mock("../../src/frontend/summary-store", () => ({
  useMetricsSummary: () => summary.value,
}));

import { createHomepageValue } from "../../src/frontend/SummaryViews";
import type { MetricsSummaryStore } from "../../src/frontend/summary-store";

afterEach(() => {
  cleanup();
  summary.value = null;
});

const useHomepage = createHomepageValue({} as MetricsSummaryStore);

describe("homepage host status values", () => {
  it("gives only the metrics the widget shows", () => {
    summary.value = {
      cpu: { percent: 20, cores: 4 },
      memory: { percent: 50, usedGiB: 2, totalGiB: 8 },
      disk: { percent: 90, usedHuman: "90G", totalHuman: "100G" },
      uptime: { formatted: "3d" },
      system: { os: "Debian", kernel: "6.1", hostname: "" },
    };
    const { result } = renderHook(() =>
      useHomepage({
        hostId: 1,
        online: true,
        shownMetrics: ["cpu", "disk", "uptime", "system"],
      }),
    );
    expect(result.current).toEqual([
      {
        shape: "bars",
        items: [
          { label: "homepage.metricCpu", value: 0.2, detail: "4c" },
          { label: "homepage.metricDisk", value: 0.9, detail: "90G/100G" },
        ],
      },
      {
        shape: "stat",
        items: [
          { label: "homepage.metricUptime", value: "3d" },
          { label: "homepage.metricOs", value: "Debian" },
          { label: "homepage.metricKernel", value: "6.1" },
        ],
      },
    ]);
  });

  it("says when there are no metrics yet, and nothing when none are asked for", () => {
    const waiting = renderHook(() =>
      useHomepage({ hostId: 1, online: true, shownMetrics: ["cpu"] }),
    );
    expect(waiting.result.current).toEqual({
      shape: "text",
      text: "homepage.metricsNotAvailable",
    });
    const none = renderHook(() =>
      useHomepage({ hostId: 1, online: true, shownMetrics: [] }),
    );
    expect(none.result.current).toBeNull();
  });

  it("lists network interfaces and processes as stats", () => {
    summary.value = {
      network: {
        interfaces: [
          { name: "eth0", ip: "10.0.0.2", rxBytes: 2048, txBytes: 0 },
        ],
      },
      processes: {
        total: 120,
        running: 2,
        top: [{ pid: 1, command: "nginx", cpu: 3 }],
      },
    };
    const { result } = renderHook(() =>
      useHomepage({
        hostId: 1,
        online: true,
        shownMetrics: ["network", "processes"],
      }),
    );
    expect(result.current).toEqual([
      { shape: "text", text: "homepage.metricNetwork" },
      {
        shape: "stat",
        items: [
          { label: "eth0", value: "10.0.0.2" },
          { label: "RX/TX", value: "2.0 KB / 0 B" },
        ],
      },
      {
        shape: "stat",
        items: [
          {
            label: "homepage.metricProcesses",
            value:
              "120 homepage.metricProcessesTotal, 2 homepage.metricProcessesRunning",
          },
          { label: "nginx", value: "3%" },
        ],
      },
    ]);
  });
});
