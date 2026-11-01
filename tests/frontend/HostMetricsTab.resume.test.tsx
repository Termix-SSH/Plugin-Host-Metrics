import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ServerMetrics } from "../../src/shared/metrics.js";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const SAMPLE = {
  cpu: { percent: 12, cores: 8, load: [0.5, 0.4, 0.3] },
  memory: { percent: 40, usedGiB: 12.8, totalGiB: 32 },
  disk: { percent: 55 },
  gpu: {
    source: "nvidia-smi",
    gpus: [
      {
        index: 0,
        uuid: "GPU-0",
        name: "GPU",
        driverVersion: "580",
        utilizationPercent: 0,
        memoryUsedMiB: 5689,
        memoryTotalMiB: 8192,
        memoryPercent: 69.4,
        temperatureCelsius: 35,
        powerDrawWatts: 24,
        powerLimitWatts: 215,
        fanPercent: 0,
      },
    ],
    processes: [],
  },
  lastChecked: "2026-09-18T07:00:00.000Z",
} as ServerMetrics;

const api = vi.hoisted(() => ({
  getMetrics: vi.fn(),
  startMetrics: vi.fn(),
  stopMetrics: vi.fn(async () => undefined),
  heartbeat: vi.fn(async () => true),
  submitTotp: vi.fn(),
  managerGet: vi.fn(() => new Promise(() => {})),
}));

vi.mock("../../src/frontend/host-metrics-api", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useHostMetricsApi: () => api,
}));

vi.mock("@termix-ssh/plugin-sdk/ui", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  logActivity: vi.fn(async () => undefined),
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSettings: () => ({ values: { backgroundGraceS: "0" } }),
}));

vi.mock("../../src/frontend/hooks/useHostMetricsPreferences.ts", () => ({
  useHostMetricsPreferences: () => ({
    layout: {
      slots: [{ id: "gpu", order: 0, colSpan: 2, height: null }],
      columns: 3,
    },
    setLayout: vi.fn(),
    loaded: true,
  }),
}));

import { HostMetricsTab } from "../../src/frontend/HostMetricsTab";

const HOST = {
  id: 1,
  name: "box",
  ip: "10.0.0.5",
  username: "admin",
  port: 22,
  authType: "password",
  pluginSettings: {
    "host-metrics": { metricsEnabled: true, metricsInterval: 30 },
  },
};

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

async function connectThenBackground() {
  render(<HostMetricsTab hostConfig={HOST} />);
  await screen.findByRole(
    "figure",
    { name: "hostMetrics.gpu.memory" },
    { timeout: 5000 },
  );
  setHidden(true);
  await waitFor(() => expect(api.stopMetrics).toHaveBeenCalled(), {
    timeout: 3000,
  });
}

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

beforeEach(() => {
  vi.clearAllMocks();
  api.getMetrics.mockResolvedValue(SAMPLE);
  api.startMetrics.mockResolvedValue({
    success: true,
    viewerSessionId: "viewer-1",
  });
});

afterEach(() => {
  cleanup();
  setHidden(false);
});

describe("HostMetricsTab coming back from the background", () => {
  it(
    "keeps the cards up and hides the connection screen while reconnecting",
    { timeout: 15_000 },
    async () => {
      await connectThenBackground();

      let finishStart: (value: unknown) => void = () => {};
      api.startMetrics.mockReturnValueOnce(
        new Promise((resolve) => {
          finishStart = resolve;
        }),
      );
      setHidden(false);
      await waitFor(() => expect(api.startMetrics).toHaveBeenCalledTimes(2), {
        timeout: 3000,
      });

      expect(screen.queryByText("hostMetrics.connecting")).toBeNull();
      expect(
        screen.getByRole("figure", { name: "hostMetrics.gpu.memory" }),
      ).toBeInTheDocument();

      await act(async () => {
        finishStart({ success: true, viewerSessionId: "viewer-2" });
      });
      expect(screen.queryByText("hostMetrics.connecting")).toBeNull();
    },
  );

  it(
    "shows the connection screen when the reconnect fails",
    { timeout: 15_000 },
    async () => {
      await connectThenBackground();

      api.startMetrics.mockRejectedValueOnce(new Error("no route"));
      setHidden(false);

      expect(
        (await screen.findAllByText("no route", {}, { timeout: 3000 })).length,
      ).toBeGreaterThan(0);
      expect(
        screen.queryByRole("figure", { name: "hostMetrics.gpu.memory" }),
      ).toBeNull();
    },
  );
});
