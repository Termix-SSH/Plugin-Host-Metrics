import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import en from "../../locales/en.json";
import {
  CardSettingsContext,
  CardSettingsView,
} from "../../src/frontend/card-settings";
import { CARD_DEFINITIONS } from "../../src/frontend/cards";
import {
  sanitizeCardSettings,
  sanitizeLayout,
  type HostMetricsCardSettings,
  type HostMetricsCardId,
} from "../../src/shared/host-metrics";
import type { ServerMetrics } from "../../src/shared/metrics";

const api = vi.hoisted(() => ({ getMetricsHistory: vi.fn() }));
vi.mock("../../src/frontend/host-metrics-api", () => ({
  useHostMetricsApi: () => api,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useSettings: () => ({ values: { temperatureUnit: "celsius" } }),
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      let value =
        key.split(".").reduce((obj: any, part) => obj?.[part], en) ??
        { "common.save": "Save", "common.cancel": "Cancel" }[key] ??
        key;
      for (const [name, replacement] of Object.entries(values))
        value = value.replaceAll(`{{${name}}}`, String(replacement));
      return value;
    },
  }),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (original) => ({
  ...(await original<object>()),
  Sparkline: ({ height }: { height: number }) => (
    <div data-testid="sparkline" data-height={height} />
  ),
  LineChart: ({ height }: { height: number }) => (
    <div data-testid="linechart" data-height={height} />
  ),
}));

const slot = {
  id: "cpu" as const,
  order: 0,
  colSpan: 1 as const,
  height: null,
};
afterEach(cleanup);
beforeEach(() => {
  api.getMetricsHistory.mockResolvedValue({
    rows: [
      {
        ts: "2026-10-22T10:00:00Z",
        cpu_percent: 20,
        mem_percent: 30,
        disk_percent: 40,
        net_rx_bytes: 0,
        net_tx_bytes: 0,
      },
      {
        ts: "2026-10-22T10:01:00Z",
        cpu_percent: 25,
        mem_percent: 35,
        disk_percent: 45,
        net_rx_bytes: 1000,
        net_tx_bytes: 2000,
      },
    ],
  });
});
function settingsView(
  settings?: HostMetricsCardSettings,
  id: HostMetricsCardId = "cpu",
) {
  const onSave = vi.fn(),
    onClose = vi.fn();
  const view = render(
    <SurfaceScope kind="tab">
      <CardSettingsView
        id={id}
        label={id}
        slot={{ ...slot, id, settings }}
        onSave={onSave}
        onClose={onClose}
      />
    </SurfaceScope>,
  );
  return { ...view, onSave, onClose };
}

describe("focused card settings", () => {
  it("uses theme accents and saves opt-in CPU graphs on the first click", () => {
    const { onSave } = settingsView();
    const graphs = screen.getByRole("checkbox", {
      name: "Show per-core history graphs",
    });
    expect(graphs).not.toBeChecked();
    expect(graphs).toHaveClass("data-[state=checked]:bg-accent-brand/20");
    expect(graphs).toHaveClass("dark:data-[state=checked]:bg-accent-brand/20");
    fireEvent.click(graphs);
    expect(graphs).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ settings: { showCoreGraphs: true } }),
    );
  });

  it("reads saved CPU graph settings and resets to the actual opt-in default", () => {
    const { onSave } = settingsView({ showCoreGraphs: true });
    const graphs = screen.getByRole("checkbox", {
      name: "Show per-core history graphs",
    });
    expect(graphs).toBeChecked();
    fireEvent.click(
      screen.getByRole("button", { name: "Reset presentation settings" }),
    );
    expect(graphs).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ settings: undefined }),
    );
  });

  it("rejects widths below the grid minimum and saves the minimum CSS-pixel width", () => {
    const { onSave } = settingsView();
    const width = screen.getByRole("spinbutton", { name: "Resize card width" });
    fireEvent.change(width, { target: { value: "160" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(width, { target: { value: "280" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ width: 280 }),
    );
  });
  it("uses an inline view, labelled controls and explicit save instead of an immediate menu change", () => {
    const { onSave, onClose } = settingsView();
    expect(screen.queryByRole("dialog")).toBeNull();
    const cores = screen.getByRole("checkbox", { name: "Show CPU cores" });
    expect(cores).toBeChecked();
    fireEvent.click(cores);
    fireEvent.change(screen.getByRole("combobox", { name: "Graph size" }), {
      target: { value: "large" },
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Resize card width" }),
      { target: { value: "580" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Increase card width" }),
    );
    expect(
      screen.getByRole("spinbutton", { name: "Resize card width" }),
    ).toHaveValue(590);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({
      settings: { showCores: false, chartSize: "large" },
      width: 590,
      height: null,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels drafts, supports automatic size and refuses out-of-range dimensions", () => {
    const { onSave, onClose } = settingsView({ showCores: false });
    fireEvent.click(
      screen.getByRole("button", { name: "Reset presentation settings" }),
    );
    expect(
      screen.getByRole("checkbox", { name: "Show CPU cores" }),
    ).toBeChecked();
    const width = screen.getByRole("spinbutton", { name: "Resize card width" });
    fireEvent.change(width, { target: { value: "-10" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Use automatic size" }));
    expect(width).toHaveValue(null);
    expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("offers sizing but no arbitrary presentation options for manager cards", () => {
    settingsView(undefined, "health_check");
    expect(screen.getAllByRole("spinbutton")).toHaveLength(2);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

const metrics: ServerMetrics = {
  lastChecked: "2026-10-22T10:00:00Z",
  cpu: {
    percent: 25,
    cores: 2,
    load: [1, 2, 3],
    perCore: [20, 30],
    mix: { user: 20, system: 5, iowait: 0, steal: 0 },
  },
  memory: { percent: 50, usedGiB: 4, totalGiB: 8, freeGiB: 3, cachedGiB: 1 },
  disk: {
    percent: 50,
    usedHuman: "5G",
    totalHuman: "10G",
    availableHuman: "5G",
  },
  network: { interfaces: [{ name: "eth0", ip: "192.0.2.1", state: "UP" }] },
  system: { hostname: "test", os: "Linux", kernel: "6.12", arch: "x86_64" },
  uptime: { seconds: 123, formatted: "2 minutes" },
  temperature: {
    sensors: [{ label: "CPU package", celsius: 60 }],
    highestCelsius: 60,
  },
  login_stats: {
    failedLogins: [
      {
        user: "failed-user",
        ip: "192.0.2.2",
        time: "2026-10-22T10:00:00Z",
        status: "failed",
      },
    ],
  },
  processes: { total: 70, running: 2, top: [] },
  ports: {
    ports: [
      {
        protocol: "tcp",
        localAddress: "127.0.0.1",
        localPort: 80,
        process: "web",
      },
    ],
  },
  firewall: { type: "ufw", status: "active", chains: [] },
  gpu: {
    source: "nvidia-smi",
    gpus: [
      {
        index: 0,
        uuid: "GPU-0",
        name: "GPU",
        driverVersion: "1",
        utilizationPercent: 30,
        memoryPercent: 20,
        memoryUsedMiB: 1024,
        memoryTotalMiB: 2048,
        temperatureCelsius: 60,
        powerDrawWatts: 100,
        powerLimitWatts: 200,
        fanPercent: 50,
      },
    ],
    processes: [
      { gpuIndex: 0, pid: 123, name: "render-worker", memoryUsedMiB: 1024 },
    ],
  },
};
function card(id: HostMetricsCardId, settings: HostMetricsCardSettings = {}) {
  return (
    <CardSettingsContext.Provider value={settings}>
      {CARD_DEFINITIONS[id].render({
        metrics,
        hostId: 7,
        histories: { cpu: [], memory: [], disk: [], gpu: {} },
      })}
    </CardSettingsContext.Provider>
  );
}

describe("saved presentation options", () => {
  it.each([
    ["cpu", "showCores", "#0"],
    ["cpu", "showLoad", "1m"],
    ["cpu", "showBreakdown", /user 20%/],
    ["memory", "showDetails", "4.0/8.0G"],
    ["memory", "showBreakdown", /cache/],
    ["disk", "showDetails", "5G/10G"],
    ["network", "showDetails", "192.0.2.1"],
    ["gpu", "showDetails", "100/200W"],
    ["gpu", "showProcesses", "render-worker"],
    ["temperature", "showSensors", "CPU package"],
    ["system", "showDetails", "6.12"],
    ["uptime", "showDetails", /123/],
    ["login_stats", "showFailedLogins", "failed-user"],
    ["processes", "showDetails", "70"],
    ["ports", "showDetails", "127.0.0.1"],
    ["firewall", "showDetails", /chains/],
  ] as const)(
    "%s applies %s without hiding the primary card",
    (id, key, text) => {
      const { rerender } = render(card(id));
      expect(screen.getByText(text)).toBeInTheDocument();
      rerender(card(id, { [key]: false }));
      expect(screen.queryByText(text)).toBeNull();
    },
  );

  it.each(["cpu", "memory", "disk", "network"] as const)(
    "%s sizes its historical graph, retaining regular defaults",
    async (id) => {
      const { rerender } = render(card(id));
      if (id !== "network")
        expect(screen.getByTestId("sparkline")).toHaveAttribute(
          "data-height",
          id === "cpu" ? "190" : "48",
        );
      rerender(card(id, { chartSize: "large" }));
      if (id !== "network")
        expect(screen.getByTestId("sparkline")).toHaveAttribute(
          "data-height",
          id === "cpu" ? "285" : "72",
        );
      fireEvent.click(screen.getByRole("button", { name: "1h" }));
      await waitFor(() =>
        expect(screen.getByTestId("linechart")).toHaveAttribute(
          "data-height",
          id === "cpu" ? "450" : "240",
        ),
      );
    },
  );

  it("sizes both GPU graphs with the same saved preference", () => {
    render(card("gpu", { chartSize: "compact" }));
    for (const line of screen.getAllByTestId("sparkline"))
      expect(line).toHaveAttribute("data-height", "23");
  });

  it("validates settings by card and safely loads legacy/corrupt layouts", () => {
    expect(
      sanitizeCardSettings("cpu", {
        chartSize: "large",
        showCores: false,
        showSensors: false,
        injected: 1,
      }),
    ).toEqual({ chartSize: "large", showCores: false });
    expect(
      sanitizeCardSettings("memory", {
        chartSize: "giant",
        showDetails: "false",
      }),
    ).toBeUndefined();
    expect(
      sanitizeCardSettings("health_check", { chartSize: "large" }),
    ).toBeUndefined();
    expect(
      sanitizeCardSettings("constructor", { chartSize: "large" }),
    ).toBeUndefined();
    expect(sanitizeLayout({ columns: 3, slots: [slot] })).toEqual({
      columns: 3,
      slots: [slot],
    });
    expect(
      sanitizeLayout({
        columns: "bad",
        slots: [null, { ...slot, settings: [false] }, slot],
      }),
    ).toEqual({ columns: 3, slots: [slot] });
    expect(sanitizeLayout({ slots: "bad" })).toBeNull();
  });
});
