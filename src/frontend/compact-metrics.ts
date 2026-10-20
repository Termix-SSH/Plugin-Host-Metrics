import type { ServerMetrics } from "../shared/metrics.js";
import { formatTemperature } from "./temperature-preference";

export interface CompactRow {
  id: string;
  labelKey: string;
  value: string;
  percent?: number | null;
  detail?: string;
}

function pct(value: number | null | undefined): string {
  return typeof value === "number" ? `${value.toFixed(0)}%` : "N/A";
}

function gib(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(1) : "?";
}

/** The few numbers worth showing in a narrow side panel. */
export function compactRows(
  metrics: ServerMetrics,
  fahrenheit = false,
): CompactRow[] {
  const rows: CompactRow[] = [];
  const load = metrics.cpu?.load;
  rows.push({
    id: "cpu",
    labelKey: "hostMetrics.cpu",
    value: pct(metrics.cpu?.percent),
    percent: metrics.cpu?.percent ?? null,
    detail: load ? `${load.map((n) => n.toFixed(2)).join("  ")}` : undefined,
  });
  rows.push({
    id: "memory",
    labelKey: "hostMetrics.memory",
    value: pct(metrics.memory?.percent),
    percent: metrics.memory?.percent ?? null,
    detail: `${gib(metrics.memory?.usedGiB)} / ${gib(metrics.memory?.totalGiB)} GiB`,
  });
  rows.push({
    id: "disk",
    labelKey: "hostMetrics.disk",
    value: pct(metrics.disk?.percent),
    percent: metrics.disk?.percent ?? null,
    detail:
      metrics.disk?.usedHuman && metrics.disk?.totalHuman
        ? `${metrics.disk.usedHuman} / ${metrics.disk.totalHuman}`
        : undefined,
  });
  const temperature = metrics.temperature?.highestCelsius;
  if (typeof temperature === "number") {
    rows.push({
      id: "temperature",
      labelKey: "hostMetrics.temperature",
      value: formatTemperature(
        temperature,
        fahrenheit ? "fahrenheit" : "celsius",
      ),
    });
  }
  if (metrics.uptime?.formatted) {
    rows.push({
      id: "uptime",
      labelKey: "hostMetrics.uptime",
      value: metrics.uptime.formatted,
    });
  }
  return rows;
}
