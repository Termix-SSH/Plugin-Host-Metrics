import { usePermission, useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { MetricsSummaryStore } from "./summary-store";
import { useMetricsSummary } from "./summary-store";
import { hostHasMetrics } from "./host-filter";
import type { ReactNode } from "react";
import type { HealthLevel } from "./host-metrics-api";
import { useDashboardHealth, type HealthSummaryStore } from "./health-summary";

const HEALTH_TONE: Record<HealthLevel, string> = {
  ok: "text-accent-brand",
  warn: "text-warning",
  crit: "text-red-400",
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

/** CPU, RAM and disk bars plus dashboard health checks in a host row ("dashboard.hostRow"). */
export function createDashboardHostMetrics(
  store: MetricsSummaryStore,
  health: HealthSummaryStore,
) {
  return function DashboardHostMetrics(props: Record<string, unknown>) {
    const { t } = useTranslation();
    const allowed = usePermission("use");
    const hostId = Number(props.hostId) || null;
    const online = props.online === true;
    const wanted = hostHasMetrics(props.host);
    const metrics = useMetricsSummary(
      store,
      allowed && online && wanted ? hostId : null,
    );
    const checks =
      useDashboardHealth(health, allowed && online ? hostId : null)?.checks ??
      [];

    const cpu = metrics?.cpu?.percent ?? null;
    const ram = metrics?.memory?.percent ?? null;
    const disk = metrics?.disk?.percent ?? null;
    if (!allowed) return null;
    const shown = checks.slice(0, MAX_ROW_CHECKS);
    const healthChecks = shown.length > 0 && (
      <>
        {shown.map((check) => (
          <div
            key={check.id}
            className="flex min-w-16 max-w-28 shrink-0 flex-col gap-0.5"
            title={`${check.name}: ${check.detail ?? ""}`}
            data-hm-health-check={check.id}
          >
            <span className="truncate text-[10px] text-muted-foreground">
              {check.name}
            </span>
            <span
              className={`truncate text-[10px] font-bold ${HEALTH_TONE[check.level]}`}
            >
              {check.detail || "-"}
            </span>
          </div>
        ))}
        {checks.length > shown.length && (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            +{checks.length - shown.length}
          </span>
        )}
      </>
    );
    if (!wanted) {
      return healthChecks ? (
        <div className="flex shrink-0 items-center gap-3">{healthChecks}</div>
      ) : null;
    }
    if (!online || (cpu === null && ram === null && disk === null)) {
      return (
        <div className="flex shrink-0 items-center gap-3">
          {healthChecks}
          {[0, 1, 2].map((slot) => (
            <span
              key={slot}
              className="text-[10px] text-muted-foreground w-16 text-center"
            >
              -
            </span>
          ))}
        </div>
      );
    }
    return (
      <div className="flex shrink-0 items-center gap-3">
        {healthChecks}
        {cpu !== null && <RowBar label={t("dashboard.cpu")} value={cpu} />}
        {ram !== null && <RowBar label={t("dashboard.ram")} value={ram} />}
        {disk !== null && (
          <RowBar label={t("dashboardTab.disk")} value={disk} />
        )}
      </div>
    );
  };
}

/**
 * The status badge of a dashboard host row ("dashboard.hostRowBadge"). A
 * dashboard check that warns or fails replaces the layout's badge; otherwise
 * the layout's own badge (`fallback`) shows.
 */
export function createDashboardHealthBadge(health: HealthSummaryStore) {
  return function DashboardHealthBadge(props: Record<string, unknown>) {
    const { t } = useTranslation();
    const allowed = usePermission("use");
    const hostId = Number(props.hostId) || null;
    const summary = useDashboardHealth(
      health,
      allowed && props.online === true ? hostId : null,
    );
    const fallback = (props.fallback ?? null) as ReactNode;
    if (!summary || summary.level === "ok") return <>{fallback}</>;
    const problems = summary.checks.filter((check) => check.level !== "ok");
    return (
      <span
        className={`shrink-0 border px-1.5 py-0.5 text-[10px] font-semibold ${
          summary.level === "crit"
            ? "border-red-500/40 text-red-500 bg-red-500/10"
            : "border-warning/40 text-warning bg-warning/10"
        }`}
        title={problems
          .map((check) => `${check.name}: ${check.detail ?? ""}`)
          .join("\n")}
        data-hm-health-badge={summary.level}
      >
        {t(
          summary.level === "crit"
            ? "hostMetrics.health.failing"
            : "hostMetrics.health.warning",
        )}
      </span>
    );
  };
}

function accentColor(): string {
  return (
    getComputedStyle(document.documentElement)
      .getPropertyValue("--accent-brand")
      .trim() || "#f59145"
  );
}

function WidgetBar({
  label,
  value,
  sublabel,
}: {
  label: string;
  value: number | null;
  sublabel?: string;
}) {
  const pct = value ?? 0;
  const color = pct > 90 ? "#ef4444" : pct > 70 ? "#f97316" : accentColor();
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className="text-right">
          {value != null ? `${Math.round(pct)}%` : "N/A"}
          {sublabel && <span className="ml-1 opacity-60">{sublabel}</span>}
        </span>
      </div>
      <div className="h-1 bg-muted overflow-hidden">
        <div
          className="h-full transition-all"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
    </div>
  );
}

function InfoRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  if (!value) return null;
  return (
    <div className="flex justify-between text-[10px] gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-foreground truncate text-right">{value}</span>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** The numbers under core's homepage host status widget ("homepage.hostMetrics"). */
export function createHomepageHostMetrics(store: MetricsSummaryStore) {
  return function HomepageHostMetrics(props: Record<string, unknown>) {
    const { t } = useTranslation();
    const allowed = usePermission("use");
    const hostId = Number(props.hostId) || null;
    const shown = (
      Array.isArray(props.shownMetrics) ? props.shownMetrics : []
    ) as MetricKey[];
    const online = props.online === true;
    const metrics = useMetricsSummary(
      store,
      allowed ? hostId : null,
      online && shown.some((m) => LIVE_METRICS.includes(m)),
    );
    if (!allowed || shown.length === 0) return null;

    const interfaces = metrics?.network?.interfaces ?? [];
    const sum = (pick: (iface: (typeof interfaces)[number]) => unknown) =>
      interfaces.reduce((total, iface) => {
        const raw = pick(iface);
        return raw ? total + parseFloat(String(raw)) : total;
      }, 0);
    const totalRx = sum((iface) => iface.rxBytes);
    const totalTx = sum((iface) => iface.txBytes);

    return (
      <div className="flex flex-col gap-2">
        {shown.includes("cpu") && (
          <WidgetBar
            label={t("homepage.metricCpu")}
            value={metrics?.cpu?.percent ?? null}
            sublabel={metrics?.cpu?.cores ? `${metrics.cpu.cores}c` : undefined}
          />
        )}
        {shown.includes("memory") && (
          <WidgetBar
            label={t("homepage.metricMemory")}
            value={metrics?.memory?.percent ?? null}
            sublabel={
              metrics?.memory?.usedGiB != null &&
              metrics?.memory?.totalGiB != null
                ? `${metrics.memory.usedGiB.toFixed(1)}/${metrics.memory.totalGiB.toFixed(1)} GiB`
                : undefined
            }
          />
        )}
        {shown.includes("disk") && (
          <WidgetBar
            label={t("homepage.metricDisk")}
            value={metrics?.disk?.percent ?? null}
            sublabel={
              metrics?.disk?.usedHuman && metrics?.disk?.totalHuman
                ? `${metrics.disk.usedHuman}/${metrics.disk.totalHuman}`
                : undefined
            }
          />
        )}
        {shown.includes("uptime") && (
          <InfoRow
            label={t("homepage.metricUptime")}
            value={metrics?.uptime?.formatted ?? null}
          />
        )}
        {shown.includes("system") && metrics?.system && (
          <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5 mt-0.5">
            <InfoRow
              label={t("homepage.metricOs")}
              value={metrics.system.os ?? null}
            />
            <InfoRow
              label={t("homepage.metricKernel")}
              value={metrics.system.kernel ?? null}
            />
            <InfoRow
              label={t("homepage.metricHostname")}
              value={metrics.system.hostname ?? null}
            />
          </div>
        )}
        {shown.includes("network") && interfaces.length > 0 && (
          <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5 mt-0.5">
            <div className="text-[10px] font-medium text-muted-foreground mb-0.5">
              {t("homepage.metricNetwork")}
            </div>
            {interfaces.slice(0, 3).map((iface) => (
              <div
                key={iface.name}
                className="flex justify-between text-[10px] gap-2"
              >
                <span className="text-muted-foreground shrink-0 truncate max-w-[60px]">
                  {iface.name}
                </span>
                <span className="text-foreground">
                  {iface.ip || iface.state}
                </span>
              </div>
            ))}
            {(totalRx > 0 || totalTx > 0) && (
              <div className="flex justify-between text-[10px] gap-2 mt-0.5">
                <span className="text-muted-foreground">RX/TX</span>
                <span className="text-foreground">
                  {formatBytes(totalRx)} / {formatBytes(totalTx)}
                </span>
              </div>
            )}
          </div>
        )}
        {shown.includes("processes") && metrics?.processes && (
          <div className="flex flex-col gap-0.5 border-t border-border/40 pt-1.5 mt-0.5">
            <div className="flex justify-between text-[10px]">
              <span className="text-muted-foreground">
                {t("homepage.metricProcesses")}
              </span>
              <span className="text-foreground">
                {metrics.processes.total ?? "?"}{" "}
                {t("homepage.metricProcessesTotal")}
                {metrics.processes.running != null
                  ? `, ${metrics.processes.running} ${t("homepage.metricProcessesRunning")}`
                  : ""}
              </span>
            </div>
            {metrics.processes.top?.slice(0, 3).map((proc) => (
              <div
                key={proc.pid}
                className="flex justify-between text-[10px] gap-2"
              >
                <span className="text-muted-foreground truncate max-w-[80px]">
                  {proc.command}
                </span>
                <span className="text-foreground shrink-0">{proc.cpu}%</span>
              </div>
            ))}
          </div>
        )}
        {!metrics && online && (
          <span className="text-[10px] text-muted-foreground/60 italic">
            {t("homepage.metricsNotAvailable")}
          </span>
        )}
      </div>
    );
  };
}
