import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ServerMetrics } from "../../../src/shared/metrics.js";
import { parseSwapMeminfo } from "../../../src/shared/swap.js";
import { SwapCard } from "../../../src/frontend/cards/SwapCard";
import { CardSettingsContext } from "../../../src/frontend/card-settings";

const getMetricsHistory = vi.hoisted(() => vi.fn());
const chart = vi.hoisted(() => vi.fn());
vi.mock("../../../src/frontend/host-metrics-api", () => ({
  useHostMetricsApi: () => ({ getMetricsHistory }),
}));
vi.mock("../../../src/frontend/cards/SmoothCharts", () => ({
  SmoothLineChart: (props: unknown) => {
    chart(props);
    return <div data-testid="swap-chart" />;
  },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

function metrics(swap: ServerMetrics["swap"]): ServerMetrics {
  return {
    cpu: { percent: 0, cores: 1, load: null },
    memory: { percent: 0, usedGiB: 0, totalGiB: 1 },
    disk: { percent: 0, usedHuman: null, totalHuman: null },
    swap,
    lastChecked: "",
  };
}
const configured = () =>
  parseSwapMeminfo("SwapTotal: 1048576 kB\nSwapFree: 786432 kB");
const card = (swap: ServerMetrics["swap"], hostId = 7) => (
  <SwapCard
    metrics={metrics(swap)}
    history={[0, 25]}
    timestamps={["a", "b"]}
    hostId={hostId}
  />
);

beforeEach(() => {
  chart.mockClear();
  getMetricsHistory.mockReset();
  getMetricsHistory.mockResolvedValue({ rows: [] });
});
afterEach(cleanup);

describe("SwapCard", () => {
  it("shows percent and used, total and free capacities with the native live chart", () => {
    render(card(configured()));
    expect(screen.getByText("hostMetrics.swapUsage")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    for (const value of ["256.00 MiB", "1.00 GiB", "768.00 MiB"]) {
      expect(screen.getByText(value)).toBeInTheDocument();
    }
    expect(chart).toHaveBeenCalledWith(
      expect.objectContaining({
        series: [expect.objectContaining({ data: [0, 25] })],
      }),
    );
  });

  it("does not round small swap use to zero bytes", () => {
    render(
      card(parseSwapMeminfo("SwapTotal: 1048572 kB\nSwapFree: 1048508 kB")),
    );
    expect(screen.getByText("64.00 KiB")).toBeInTheDocument();
  });

  it("shows no swap distinctly from unavailable metrics", () => {
    const view = render(
      card(parseSwapMeminfo("SwapTotal: 0 kB\nSwapFree: 0 kB")),
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "hostMetrics.swapNone",
    );
    expect(screen.queryByText("0%")).toBeNull();
    view.rerender(card(null));
    expect(screen.getByRole("status")).toHaveTextContent(
      "hostMetrics.swapUnavailable",
    );
  });

  it("honours the card's presentation settings", () => {
    render(
      <CardSettingsContext.Provider value={{ showDetails: false }}>
        {card(configured())}
      </CardSettingsContext.Provider>,
    );
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.queryByText("256.00 MiB")).toBeNull();
  });

  it("loads the selected time range with null gaps for older samples", async () => {
    getMetricsHistory.mockResolvedValue({
      rows: [
        { ts: "a", swap_percent: null },
        { ts: "b", swap_percent: 25 },
      ],
    });
    render(card(configured()));
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    await waitFor(() =>
      expect(getMetricsHistory).toHaveBeenCalledWith(7, { range: "1h" }),
    );
    await waitFor(() =>
      expect(chart).toHaveBeenLastCalledWith(
        expect.objectContaining({
          series: [expect.objectContaining({ data: [null, 25] })],
        }),
      ),
    );
  });

  it("reports history request failures instead of showing an empty success state", async () => {
    getMetricsHistory.mockRejectedValue(new Error("offline"));
    render(card(configured()));
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "hostMetrics.swapHistoryFailed",
    );
    expect(screen.queryByText("metricsHistory.noData")).toBeNull();
  });

  it("shows no history when all old readings lack swap fields", async () => {
    getMetricsHistory.mockResolvedValue({ rows: [{ ts: "a" }] });
    render(card(configured()));
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    expect(
      await screen.findByText("metricsHistory.noData"),
    ).toBeInTheDocument();
  });

  it("does not display another host's history while the next request is pending", async () => {
    getMetricsHistory.mockResolvedValueOnce({
      rows: [{ ts: "a", swap_percent: 25 }],
    });
    const view = render(card(configured(), 7));
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    await screen.findByTestId("swap-chart");
    getMetricsHistory.mockImplementation(() => new Promise(() => {}));
    view.rerender(card(configured(), 8));
    expect(screen.queryByTestId("swap-chart")).toBeNull();
    await waitFor(() =>
      expect(getMetricsHistory).toHaveBeenLastCalledWith(8, { range: "1h" }),
    );
  });
});
