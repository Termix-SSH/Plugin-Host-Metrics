import {
  usePermission,
  useTranslation,
  type DataBar,
  type DataResult,
  type DataStat,
  type DataTone,
  type DataValue,
} from "@termix-ssh/plugin-sdk/frontend";
import type { MetricsSummaryStore } from "./summary-store";
import { useMetricsSummary } from "./summary-store";
import { hostHasMetrics } from "./host-filter";
import type { HealthLevel } from "./host-metrics-api";
import { useDashboardHealth, type HealthSummaryStore } from "./health-summary";

const HEALTH_TONE: Record<HealthLevel, DataTone> = {
  ok: "default",
  warn: "warn",
  crit: "bad",
};
// Room for a few checks next to the bars; the rest are counted.
const MAX_ROW_CHECKS = 3;

/** The widget fields the live sample can refresh; the rest keep the regular value. */
const LIVE_METRICS = ["cpu", "memory", "network", "processes"];

type MetricKey =
  "cpu" | "memory" | "disk" | "uptime" | "system" | "network" | "processes";

export function RowBar({ label, value }: { label: string; value: number }) {
  const tone =
    value >= 90
      ? ["bg-red-500", "text-red-400"]
      : value >= 70
        ? ["bg-warning", "text-warning"]
        : ["bg-accent-brand", "text-accent-brand"];
  return (
    <div className="flex flex-col gap-0.5 min-w-16 shrink-0">
      <div className="flex items-center justify-between gap-1 whitespace-nowrap">
        <span className="text-[10px] text-muted-foreground">{label}</span>
        <span className={`text-[10px] font-bold ${tone[1]}`}>
          {value.toFixed(0)}%
        </span>
      </div>
      <div className="h-0.5 bg-muted w-full">
        <div className={`h-full ${tone[0]}`} style={{ width: `${value}%` }} />
      </div>
    </div>
  );
}

/** A percent from the API as a 0..1 share, or null. */
function share(percent: number | null | undefined): number | null {
  return typeof percent === "number" && Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent)) / 100
    : null;
}

function hostIdOf(context: Record<string, unknown>): number | null {
  return Number(context.hostId) || null;
}

/**
 * CPU, RAM and disk bars plus dashboard health checks for a host row
 * ("dashboard.hostRow", a data slot). Runs once per row on screen.
 */
export function createDashboardRowValue(
  store: MetricsSummaryStore,
  health: HealthSummaryStore,
) {
  return function useDashboardRowValue(
    context: Record<string, unknown>,
  ): DataResult {
    const { t } = useTranslation();
    const allowed = usePermission("use");
    const hostId = hostIdOf(context);
    const online = context.online === true;
    const wanted = hostHasMetrics(context.host);
    const metrics = useMetricsSummary(
      store,
      allowed && online && wanted ? hostId : null,
    );
    const checks =
      useDashboardHealth(health, allowed && online ? hostId : null)?.checks ??
      [];
    if (!allowed) return null;

    const values: DataValue[] = [];
    const shown = checks.slice(0, MAX_ROW_CHECKS);
    if (shown.length > 0) {
      values.push({
        shape: "stat",
        items: shown.map((check) => ({
          label: check.name,
          value: check.detail || "-",
          tone: HEALTH_TONE[check.level],
          tooltip: `${check.name}: ${check.detail ?? ""}`,
        })),
      });
      if (checks.length > shown.length) {
        values.push({
          shape: "text",
          text: `+${checks.length - shown.length}`,
        });
      }
    }
    if (!wanted) return values.length > 0 ? values : null;

    const cpu = online ? share(metrics?.cpu?.percent) : null;
    const ram = online ? share(metrics?.memory?.percent) : null;
    const disk = online ? share(metrics?.disk?.percent) : null;
    // Unknown values keep their place, so rows line up while they load.
    if (cpu === null && ram === null && disk === null) {
      values.push({
        shape: "bars",
        items: [
          { label: t("dashboard.cpu"), value: null },
          { label: t("dashboard.ram"), value: null },
          { label: t("dashboardTab.disk"), value: null },
        ],
      });
      return values;
    }
    const items = [
      cpu !== null && { label: t("dashboard.cpu"), value: cpu },
      ram !== null && { label: t("dashboard.ram"), value: ram },
      disk !== null && { label: t("dashboardTab.disk"), value: disk },
    ].filter((item): item is DataBar => !!item);
    values.push({ shape: "bars", items });
    return values;
  };
}

/**
 * The status badge of a dashboard host row ("dashboard.hostRowBadge"). A
 * dashboard check that warns or fails replaces the layout's badge; null
 * leaves the layout's own badge.
 */
export function createDashboardBadgeValue(health: HealthSummaryStore) {
  return function useDashboardBadgeValue(
    context: Record<string, unknown>,
  ): DataResult {
    const { t } = useTranslation();
    const allowed = usePermission("use");
    const summary = useDashboardHealth(
      health,
      allowed && context.online === true ? hostIdOf(context) : null,
    );
    if (!summary || summary.level === "ok") return null;
    const problems = summary.checks.filter((check) => check.level !== "ok");
    return {
      shape: "badge",
      label: t(
        summary.level === "crit"
          ? "hostMetrics.health.failing"
          : "hostMetrics.health.warning",
      ),
      tone: summary.level === "crit" ? "bad" : "warn",
      tooltip: problems
        .map((check) => `${check.name}: ${check.detail ?? ""}`)
        .join("\n"),
    };
  };
}

function formatBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Stats with a value; empty ones are left out. */
function stats(items: Array<DataStat | false>): DataValue | null {
  const kept = items.filter(
    (item): item is DataStat =>
      item !== false && item.value !== null && item.value !== "",
  );
  return kept.length > 0 ? { shape: "stat", items: kept } : null;
}

/**
 * The numbers under the homepage's host status widget
 * ("homepage.hostMetrics"). The widget says which metrics it shows.
 */
export function createHomepageValue(store: MetricsSummaryStore) {
  return function useHomepageValue(
    context: Record<string, unknown>,
  ): DataResult {
    const { t } = useTranslation();
    const allowed = usePermission("use");
    const hostId = hostIdOf(context);
    const shown = (
      Array.isArray(context.shownMetrics) ? context.shownMetrics : []
    ) as MetricKey[];
    const online = context.online === true;
    const metrics = useMetricsSummary(
      store,
      allowed ? hostId : null,
      online && shown.some((m) => LIVE_METRICS.includes(m)),
    );
    if (!allowed || shown.length === 0) return null;
    if (!metrics) {
      return online
        ? { shape: "text", text: t("homepage.metricsNotAvailable") }
        : null;
    }

    const values: DataValue[] = [];
    const bars = (
      [
        shown.includes("cpu") && {
          label: t("homepage.metricCpu"),
          value: share(metrics.cpu?.percent),
          detail: metrics.cpu?.cores ? `${metrics.cpu.cores}c` : undefined,
        },
        shown.includes("memory") && {
          label: t("homepage.metricMemory"),
          value: share(metrics.memory?.percent),
          detail:
            metrics.memory?.usedGiB != null && metrics.memory?.totalGiB != null
              ? `${metrics.memory.usedGiB.toFixed(1)}/${metrics.memory.totalGiB.toFixed(1)} GiB`
              : undefined,
        },
        shown.includes("disk") && {
          label: t("homepage.metricDisk"),
          value: share(metrics.disk?.percent),
          detail:
            metrics.disk?.usedHuman && metrics.disk?.totalHuman
              ? `${metrics.disk.usedHuman}/${metrics.disk.totalHuman}`
              : undefined,
        },
      ] as Array<DataBar | false>
    ).filter((item): item is DataBar => !!item);
    if (bars.length > 0) values.push({ shape: "bars", items: bars });

    const info = stats([
      shown.includes("uptime") && {
        label: t("homepage.metricUptime"),
        value: metrics.uptime?.formatted ?? null,
      },
      shown.includes("system") && {
        label: t("homepage.metricOs"),
        value: metrics.system?.os ?? null,
      },
      shown.includes("system") && {
        label: t("homepage.metricKernel"),
        value: metrics.system?.kernel ?? null,
      },
      shown.includes("system") && {
        label: t("homepage.metricHostname"),
        value: metrics.system?.hostname ?? null,
      },
    ]);
    if (info) values.push(info);

    if (shown.includes("network")) {
      const interfaces = metrics.network?.interfaces ?? [];
      const sum = (pick: (iface: (typeof interfaces)[number]) => unknown) =>
        interfaces.reduce((total, iface) => {
          const raw = pick(iface);
          return raw ? total + parseFloat(String(raw)) : total;
        }, 0);
      const totalRx = sum((iface) => iface.rxBytes);
      const totalTx = sum((iface) => iface.txBytes);
      const network = stats([
        ...interfaces.slice(0, 3).map((iface) => ({
          label: iface.name,
          value: iface.ip || iface.state || null,
        })),
        (totalRx > 0 || totalTx > 0) && {
          label: "RX/TX",
          value: `${formatBytes(totalRx)} / ${formatBytes(totalTx)}`,
        },
      ]);
      if (network) {
        values.push({ shape: "text", text: t("homepage.metricNetwork") });
        values.push(network);
      }
    }

    if (shown.includes("processes") && metrics.processes) {
      const processes = metrics.processes;
      const summary = `${processes.total ?? "?"} ${t("homepage.metricProcessesTotal")}${
        processes.running != null
          ? `, ${processes.running} ${t("homepage.metricProcessesRunning")}`
          : ""
      }`;
      const list = stats([
        { label: t("homepage.metricProcesses"), value: summary },
        ...(processes.top ?? []).slice(0, 3).map((proc) => ({
          label: String(proc.command),
          value: `${proc.cpu}%`,
        })),
      ]);
      if (list) values.push(list);
    }

    return values.length > 0 ? values : null;
  };
}
