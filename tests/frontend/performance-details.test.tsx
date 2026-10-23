import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, renderHook } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import en from "../../locales/en.json";
import { CardSettingsContext } from "../../src/frontend/card-settings";
import {
  CpuPerformance,
  MemoryPerformance,
  DiskPerformance,
  NetworkPerformance,
  usePerformanceHistory,
  appendPerformanceHistory,
  formatPerformanceValue,
} from "../../src/frontend/cards/PerformanceDetails";
import {
  sanitizeCardSettings,
  type HostMetricsCardSettings,
} from "../../src/shared/host-metrics";
import type {
  CpuDetails,
  MemoryDetails,
  ServerMetrics,
} from "../../src/shared/metrics";
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      let value = key.split(".").reduce((o: any, k) => o?.[k], en) ?? key;
      for (const [k, v] of Object.entries(values))
        value = value.replaceAll(`{{${k}}}`, String(v));
      return value;
    },
  }),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  Sparkline: ({ data, domain, height }: any) => (
    <div
      data-testid="history"
      data-series={JSON.stringify(data)}
      data-domain={JSON.stringify(domain)}
      data-height={height}
    />
  ),
  LineChart: ({ series, domain, height }: any) => (
    <div
      data-testid="history"
      data-series={JSON.stringify(series)}
      data-domain={JSON.stringify(domain)}
      data-height={height}
    />
  ),
}));
afterEach(cleanup);
const cpu: CpuDetails = {
  model: "Fixture CPU",
  currentGHz: 3.2,
  baseGHz: null,
  maxGHz: 4,
  sockets: 1,
  physicalCores: 4,
  logicalCores: 8,
  virtualization: null,
  l1Bytes: 65536,
  l2Bytes: 1048576,
  l3Bytes: 8388608,
  processes: 100,
  threads: 1000,
  handles: 3000,
  uptimeSeconds: 90061,
  semantics: "windows",
};
const memory: MemoryDetails = {
  availableBytes: 2147483648,
  compressedBytes: null,
  committedBytes: 4294967296,
  commitLimitBytes: 17179869184,
  cachedBytes: 1073741824,
  pagedPoolBytes: 1048576,
  nonpagedPoolBytes: 2097152,
  reclaimableSlabBytes: null,
  unreclaimableSlabBytes: null,
  wiredBytes: null,
  installedBytes: 8589934592,
  hardwareReservedBytes: 0,
  speedMHz: 3200,
  slotsUsed: 2,
  slotsTotal: 4,
  memoryType: "DDR4",
  formFactor: "DIMM",
  semantics: "windows",
};
const metrics: ServerMetrics = {
  cpu: {
    percent: 50,
    cores: 8,
    load: null,
    perCore: [25, null],
    coreIds: ["0", "2"],
    details: cpu,
  },
  memory: { percent: 75, usedGiB: 6, totalGiB: 8, details: memory },
  disk: {
    percent: 99,
    usedHuman: "99G",
    totalHuman: "100G",
    devices: [
      {
        id: "nvme0n1",
        model: "Fixture SSD",
        media: "SSD",
        bus: "NVMe",
        capacityBytes: 1000000000000,
        formattedBytes: null,
        system: null,
        pagefile: null,
        activePercent: 12.5,
        readBps: 1024,
        writeBps: null,
        latencyMs: null,
      },
    ],
  },
  network: {
    interfaces: [
      {
        name: "eth0",
        state: "UP",
        ip: "192.0.2.1",
        rxRateBps: 1024,
        txRateBps: null,
        details: {
          model: "Fixture NIC",
          type: "Ethernet",
          ipv4: ["192.0.2.1"],
          ipv6: ["2001:db8::1"],
          dns: ["192.0.2.53"],
          linkMbps: 1000,
          duplex: "full",
          mac: "aa:bb",
        },
      },
    ],
  },
  lastChecked: "2026-10-22T12:00:00Z",
};
function view(node: React.ReactNode, settings: HostMetricsCardSettings = {}) {
  return (
    <CardSettingsContext.Provider value={settings}>
      {node}
    </CardSettingsContext.Provider>
  );
}
describe("performance presentation", () => {
  it("shows opted-in CPU histories and hides them when cores are disabled", () => {
    const { rerender } = render(
      view(<CpuPerformance metrics={metrics} hostId={1} />, {
        showCoreGraphs: true,
      }),
    );
    expect(screen.getAllByTestId("history").length).toBeGreaterThan(0);
    rerender(
      view(<CpuPerformance metrics={metrics} hostId={1} />, {
        showCoreGraphs: true,
        showCores: false,
      }),
    );
    expect(screen.queryByTestId("history")).toBeNull();
  });

  it("CPU hardware, unavailable values, system counters and logical histories respect settings", () => {
    const { rerender } = render(
      view(<CpuPerformance metrics={metrics} hostId={1} />),
    );
    expect(screen.getByText("Fixture CPU")).toBeInTheDocument();
    expect(screen.getByText("3.20 GHz")).toBeInTheDocument();
    expect(screen.getByText("1d 1h 1m")).toBeInTheDocument();
    expect(screen.queryByText("Unavailable")).toBeNull();
    // per-core graphs are opt-in; the animated bars on the card cover the default view
    expect(screen.queryByTestId("history")).toBeNull();
    rerender(
      view(<CpuPerformance metrics={metrics} hostId={1} />, {
        showHardware: false,
        showSystemCounts: false,
        showCores: false,
      }),
    );
    expect(screen.queryByText("Fixture CPU")).toBeNull();
    expect(screen.queryByText("Processes")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });
  it("memory composition works on slow Windows metrics, does not stack overlapping cached bytes, and is configurable", () => {
    const { rerender } = render(view(<MemoryPerformance metrics={metrics} />));
    const bar = screen.getByRole("img", {
      name: "Memory composition: 6.00 GiB in use, 2.00 GiB available",
    });
    expect(bar.children[0]).toHaveStyle({ width: "75%" });
    expect(bar.children).toHaveLength(1);
    expect(screen.getByText("DDR4")).toBeInTheDocument();
    expect(screen.getByText("3200 MHz")).toBeInTheDocument();
    expect(screen.queryByText("Compressed physical memory")).toBeNull();
    rerender(
      view(<MemoryPerformance metrics={metrics} />, {
        showComposition: false,
        showHardware: false,
      }),
    );
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.queryByText("DDR4")).toBeNull();
    expect(screen.queryByText("Commit limit")).toBeNull();
  });
  it("Linux equivalents stay explicit and unknown RAM hardware stays unavailable", () => {
    const linux = {
      ...metrics,
      memory: {
        ...metrics.memory,
        details: {
          ...memory,
          semantics: "linux" as const,
          installedBytes: null,
          reclaimableSlabBytes: 1024,
          pagedPoolBytes: null,
        },
      },
    };
    render(view(<MemoryPerformance metrics={linux} />));
    expect(
      screen.getByText("Committed virtual memory (Linux)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Page cache + buffers (Linux)"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Paged pool (Windows)")).toBeNull();
    expect(screen.queryByText("Installed memory")).toBeNull();
  });
  it("physical activity is not filesystem utilization; histories preserve nulls and settings", () => {
    const { rerender } = render(
      view(<DiskPerformance metrics={metrics} hostId={1} />),
    );
    expect(screen.getByText("12.5%")).toBeInTheDocument();
    expect(screen.queryByText("99%")).toBeNull();
    expect(screen.queryByText("Average transfer latency")).toBeNull();
    const graphs = screen.getAllByTestId("history");
    expect(JSON.parse(graphs[1].getAttribute("data-series")!)[1].data).toEqual([
      null,
    ]);
    rerender(
      view(<DiskPerformance metrics={metrics} hostId={1} />, {
        showActivity: false,
      }),
    );
    expect(screen.queryByTestId("history")).toBeNull();
    expect(screen.getByText("Fixture SSD")).toBeInTheDocument();
    rerender(
      view(<DiskPerformance metrics={metrics} hostId={1} />, {
        showActivity: false,
        showHardware: false,
      }),
    );
    expect(screen.queryByText("Physical devices")).toBeNull();
  });
  it("network histories are per interface with address/link/settings groups", () => {
    const { rerender } = render(
      view(<NetworkPerformance metrics={metrics} hostId={1} />, {
        chartSize: "large",
      }),
    );
    expect(screen.getByText("2001:db8::1")).toBeInTheDocument();
    expect(screen.getByText("192.0.2.53")).toBeInTheDocument();
    expect(screen.getByText("1,000 Mbps")).toBeInTheDocument();
    expect(screen.getByTestId("history")).toHaveAttribute("data-height", "108");
    expect(
      screen.getByRole("img", { name: "eth0: Receive / eth0: Send" }),
    ).toBeInTheDocument();
    rerender(
      view(<NetworkPerformance metrics={metrics} hostId={1} />, {
        showActivity: false,
        showAddresses: false,
        showLink: false,
      }),
    );
    expect(screen.queryByTestId("history")).toBeNull();
    expect(screen.queryByText("2001:db8::1")).toBeNull();
    expect(screen.queryByText("Fixture NIC")).toBeNull();
  });
  it("all new group switches persist only on supported cards", () => {
    expect(
      sanitizeCardSettings("cpu", {
        showHardware: false,
        showSystemCounts: false,
        showActivity: true,
      }),
    ).toEqual({ showHardware: false, showSystemCounts: false });
    expect(
      sanitizeCardSettings("memory", {
        showHardware: false,
        showComposition: false,
      }),
    ).toEqual({ showHardware: false, showComposition: false });
    expect(
      sanitizeCardSettings("disk", {
        showActivity: false,
        showHardware: false,
      }),
    ).toEqual({ showActivity: false, showHardware: false });
    expect(
      sanitizeCardSettings("network", {
        showActivity: false,
        showLink: false,
        showAddresses: false,
      }),
    ).toEqual({ showActivity: false, showLink: false, showAddresses: false });
  });
  it("history is bounded, null-preserving, host-keyed and drops departed interface/core histories", () => {
    let points = Array.from({ length: 100 }, (_, i) => ({
      ts: String(i),
      values: { a: i },
    }));
    expect(
      appendPerformanceHistory(points, { ts: "now", values: { a: null } }),
    ).toHaveLength(60);
    const { result, rerender } = renderHook(
      ({ hostId, values, stamp }) =>
        usePerformanceHistory(hostId, values, stamp),
      {
        initialProps: {
          hostId: 1,
          values: { a: 1 } as Record<string, number | null>,
          stamp: "1",
        },
      },
    );
    expect(result.current).toHaveLength(1);
    rerender({ hostId: 1, values: { a: null }, stamp: "2" });
    expect(result.current[1].values.a).toBeNull();
    rerender({ hostId: 2, values: { b: 99 }, stamp: "3" });
    expect(result.current).toHaveLength(1);
    expect(result.current[0].values).toEqual({ b: 99 });
    rerender({ hostId: 2, values: { c: 5 }, stamp: "4" });
    expect(result.current.at(-1)?.values).toEqual({ c: 5 });
  });
  it("does not format unavailable/nonfinite counters as zero", () => {
    expect(formatPerformanceValue("latencyMs", null, "Unavailable")).toBe(
      "Unavailable",
    );
    expect(formatPerformanceValue("readBps", NaN, "Unavailable")).toBe(
      "Unavailable",
    );
    expect(formatPerformanceValue("readBps", 0, "Unavailable")).toBe(
      "0.0 KiB/s",
    );
  });
});
