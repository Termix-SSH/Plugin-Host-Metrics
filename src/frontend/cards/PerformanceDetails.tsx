import { useEffect, useState } from "react";
import {
  LineChart,
  Sparkline,
  type LineChartSeries,
} from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { ServerMetrics } from "../../shared/metrics.js";
import { useSmoothSeries } from "./SmoothCharts";
import { chartHeight, useCardSettings } from "../card-settings";

export type HistoryPoint = {
  ts: string;
  values: Record<string, number | null>;
};
export function appendPerformanceHistory(
  history: HistoryPoint[],
  point: HistoryPoint,
): HistoryPoint[] {
  return [...history, point].slice(-60);
}
/** Host-keyed from the first render, not just after effect cleanup. Missing samples stay gaps. */
export function usePerformanceHistory(
  hostId: number | null,
  values: Record<string, number | null>,
  stamp?: string,
) {
  const signature = JSON.stringify(values);
  const [state, setState] = useState<{
    hostId: number | null;
    points: HistoryPoint[];
  }>({ hostId, points: [] });
  useEffect(() => {
    if (hostId == null || !stamp) return;
    const point = {
      ts: new Date().toISOString(),
      values: JSON.parse(signature),
    };
    setState((previous) => ({
      hostId,
      points: appendPerformanceHistory(
        previous.hostId === hostId ? previous.points : [],
        point,
      ),
    }));
  }, [hostId, stamp, signature]);
  return state.hostId === hostId ? state.points : [];
}
const byteKeys = new Set([
  "l1Bytes",
  "l2Bytes",
  "l3Bytes",
  "availableBytes",
  "compressedBytes",
  "committedBytes",
  "commitLimitBytes",
  "cachedBytes",
  "pagedPoolBytes",
  "nonpagedPoolBytes",
  "reclaimableSlabBytes",
  "unreclaimableSlabBytes",
  "wiredBytes",
  "installedBytes",
  "hardwareReservedBytes",
  "capacityBytes",
  "formattedBytes",
]);
export function formatPerformanceValue(
  key: string,
  value: unknown,
  unavailable: string,
): string {
  if (value == null || (Array.isArray(value) && !value.length))
    return unavailable;
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return unavailable;
    if (byteKeys.has(key)) {
      if (value >= 1073741824) return `${(value / 1073741824).toFixed(2)} GiB`;
      if (value >= 1048576) return `${(value / 1048576).toFixed(1)} MiB`;
      if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
      return `${value} B`;
    }
    if (key.endsWith("GHz")) return `${value.toFixed(2)} GHz`;
    if (key.endsWith("Bps")) return `${(value / 1024).toFixed(1)} KiB/s`;
    if (key === "activePercent") return `${value.toFixed(1)}%`;
    if (key === "latencyMs") return `${value.toFixed(2)} ms`;
    if (key === "linkMbps") return `${value.toLocaleString()} Mbps`;
    if (key === "speedMHz") return `${value} MHz`;
    if (key === "uptimeSeconds") {
      const days = Math.floor(value / 86400),
        hours = Math.floor((value % 86400) / 3600),
        mins = Math.floor((value % 3600) / 60);
      return `${days}d ${hours}h ${mins}m`;
    }
  }
  return String(value);
}
function DetailGrid({
  data,
  fields,
  semantics,
}: {
  data: object | undefined;
  fields: string[];
  semantics?: string;
}) {
  const { t } = useTranslation();
  const unavailable = t("hostMetrics.performance.unavailable");
  // Hide fields this OS/host does not report instead of showing "Unavailable".
  const shown = fields.filter((key) => {
    const v = (data as Record<string, unknown> | undefined)?.[key];
    return !(
      v == null ||
      (Array.isArray(v) && !v.length) ||
      (typeof v === "number" && !Number.isFinite(v))
    );
  });
  if (!shown.length) return null;
  return (
    <dl className="grid min-w-0 grid-cols-2 gap-x-3 gap-y-2 text-xs">
      {shown.map((key) => {
        const value = (data as Record<string, unknown> | undefined)?.[key];
        const label =
          key === "handles" && semantics === "linux"
            ? "linuxFileHandles"
            : key === "committedBytes" && semantics === "linux"
              ? "linuxCommitted"
              : key === "cachedBytes" && semantics === "linux"
                ? "linuxCached"
                : key === "cachedBytes" && semantics === "darwin"
                  ? "darwinCached"
                  : key;
        const text =
          typeof value === "boolean"
            ? t(`hostMetrics.performance.${value ? "yes" : "no"}`)
            : key === "virtualization" &&
                (value === "enabled" || value === "disabled")
              ? t(`hostMetrics.performance.${value}`)
              : formatPerformanceValue(key, value, unavailable);
        return (
          <div key={key} className="min-w-0">
            <dt className="text-muted-foreground">
              {t(`hostMetrics.performance.${label}`)}
            </dt>
            <dd className="break-words font-mono [overflow-wrap:anywhere]">
              {text}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2 border-t border-border pt-2">
      <h5 className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h5>
      {children}
    </section>
  );
}
function HistoryGraph({
  points,
  keys,
  labels,
  percent = false,
  compact = false,
  height = 72,
}: {
  points: HistoryPoint[];
  keys: string[];
  labels: string[];
  percent?: boolean;
  compact?: boolean;
  height?: number;
}) {
  const settings = useCardSettings();
  const smooth = useSmoothSeries(
    keys.map((key) => points.map((p) => p.values[key] ?? null)),
  );
  if (!points.some((p) => keys.some((k) => p.values[k] != null))) return null;
  if (compact)
    return (
      <div role="img" aria-label={labels.join(" / ")} className="min-w-0">
        <Sparkline
          data={smooth[0] as Array<number | null>}
          domain={[0, 100]}
          height={chartHeight(settings, height)}
        />
      </div>
    );
  const series: LineChartSeries[] = keys.map((key, i) => ({
    key,
    label: labels[i],
    color: i % 2 ? "var(--chart-5)" : "var(--accent-brand)",
    data: smooth[i] as Array<number | null>,
  }));
  const max = percent
    ? 100
    : Math.max(1024, ...series.flatMap((s) => s.data.map((v) => v ?? 0)));
  return (
    <div role="img" aria-label={labels.join(" / ")} className="min-w-0">
      <LineChart
        series={series}
        timestamps={points.map((p) => p.ts)}
        domain={[0, max]}
        height={chartHeight(settings, height)}
        yFormatter={(v) =>
          percent ? `${v.toFixed(0)}%` : `${(v / 1024).toFixed(0)} KiB/s`
        }
      />
    </div>
  );
}
export function CpuPerformance({
  metrics,
  hostId,
}: {
  metrics: ServerMetrics | null;
  hostId: number | null;
}) {
  const settings = useCardSettings(),
    { t } = useTranslation();
  const d = metrics?.cpu.details;
  const values: Record<string, number | null> = {};
  metrics?.cpu.perCore?.forEach(
    (v, i) => (values[metrics.cpu.coreIds?.[i] ?? String(i)] = v),
  );
  const points = usePerformanceHistory(hostId, values, metrics?.lastChecked);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {settings.showHardware !== false && (
        <Section title={t("hostMetrics.performance.sectionHardware")}>
          <DetailGrid
            data={d}
            fields={[
              "model",
              "currentGHz",
              "baseGHz",
              "maxGHz",
              "sockets",
              "physicalCores",
              "logicalCores",
              "virtualization",
              "l1Bytes",
              "l2Bytes",
              "l3Bytes",
            ]}
          />
        </Section>
      )}
      {settings.showSystemCounts !== false && (
        <Section title={t("hostMetrics.performance.sectionCounters")}>
          <DetailGrid
            data={d}
            semantics={d?.semantics}
            fields={["processes", "threads", "handles", "uptimeSeconds"]}
          />
        </Section>
      )}
      {settings.showCoreGraphs === true &&
        settings.showCores !== false &&
        (Object.keys(values).length ? (
          <div className="grid min-w-0 grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-2">
            {Object.keys(values).map((key) => (
              <div key={key} className="min-w-0">
                <div className="text-xs text-muted-foreground">
                  {t("hostMetrics.performance.logicalProcessor", { id: key })}
                </div>
                <HistoryGraph
                  points={points}
                  keys={[key]}
                  labels={[
                    t("hostMetrics.performance.logicalProcessor", { id: key }),
                  ]}
                  percent
                  compact
                  height={130}
                />
              </div>
            ))}
          </div>
        ) : null)}
    </div>
  );
}
export function MemoryPerformance({
  metrics,
}: {
  metrics: ServerMetrics | null;
}) {
  const details = metrics?.memory.details;
  const settings = useCardSettings(),
    { t } = useTranslation();
  const total =
    metrics?.memory.totalGiB != null
      ? metrics.memory.totalGiB * 1073741824
      : null;
  const available = details?.availableBytes;
  const used =
    total != null && available != null && available <= total
      ? total - available
      : null;
  const compressed =
    used != null && details?.compressedBytes != null
      ? Math.min(used, details.compressedBytes)
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {settings.showComposition !== false &&
        used != null &&
        total != null &&
        total > 0 && (
          <div className="flex flex-col gap-1">
            <div
              role="img"
              aria-label={t("hostMetrics.performance.compositionLabel", {
                used: formatPerformanceValue("availableBytes", used, ""),
                available: formatPerformanceValue(
                  "availableBytes",
                  available,
                  "",
                ),
              })}
              className="flex h-3 w-full overflow-hidden bg-muted"
            >
              <div
                className="bg-accent-brand"
                style={{
                  width: `${((used - (compressed ?? 0)) / total) * 100}%`,
                }}
              />
              {compressed != null && (
                <div
                  className="bg-chart-3"
                  style={{ width: `${(compressed / total) * 100}%` }}
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("hostMetrics.performance.compositionHint")}
            </p>
          </div>
        )}
      {settings.showComposition !== false && (
        <DetailGrid
          data={details}
          semantics={details?.semantics}
          fields={[
            "availableBytes",
            "compressedBytes",
            "committedBytes",
            "commitLimitBytes",
            "cachedBytes",
            "pagedPoolBytes",
            "nonpagedPoolBytes",
            ...(details?.semantics === "linux"
              ? ["reclaimableSlabBytes", "unreclaimableSlabBytes"]
              : details?.semantics === "darwin"
                ? ["wiredBytes"]
                : []),
          ]}
        />
      )}
      {settings.showHardware !== false && (
        <Section title={t("hostMetrics.performance.sectionHardware")}>
          <DetailGrid
            data={details}
            semantics={details?.semantics}
            fields={[
              "installedBytes",
              "memoryType",
              "speedMHz",
              "slotsUsed",
              "slotsTotal",
              "formFactor",
              "hardwareReservedBytes",
            ]}
          />
        </Section>
      )}
    </div>
  );
}
export function DiskPerformance({
  metrics,
  hostId,
}: {
  metrics: ServerMetrics | null;
  hostId: number | null;
}) {
  const settings = useCardSettings(),
    { t } = useTranslation();
  const disks = metrics?.disk.devices ?? [];
  const values: Record<string, number | null> = {};
  for (const d of disks)
    for (const k of ["activePercent", "readBps", "writeBps"] as const)
      values[`${d.id}:${k}`] = d[k];
  const points = usePerformanceHistory(hostId, values, metrics?.lastChecked);
  if (
    !disks.length ||
    (settings.showActivity === false && settings.showHardware === false)
  )
    return null;
  return (
    <section
      aria-label={t("hostMetrics.performance.physicalDisks")}
      className="flex min-w-0 flex-col gap-3"
    >
      <h4 className="text-xs font-semibold">
        {t("hostMetrics.performance.physicalDisks")}
      </h4>
      <p className="text-xs text-muted-foreground">
        {t("hostMetrics.performance.diskDistinction")}
      </p>
      {disks.map((d) => (
        <div
          key={d.id}
          className="flex min-w-0 flex-col gap-2 border-t border-border pt-2"
        >
          <h5 className="break-words font-mono text-xs">{d.id}</h5>
          {settings.showHardware !== false && (
            <DetailGrid
              data={d}
              fields={[
                "model",
                "media",
                "bus",
                "capacityBytes",
                "formattedBytes",
                "system",
                "pagefile",
              ]}
            />
          )}
          {settings.showActivity !== false && (
            <>
              <DetailGrid
                data={d}
                fields={["activePercent", "readBps", "writeBps", "latencyMs"]}
              />
              <HistoryGraph
                points={points}
                keys={[`${d.id}:activePercent`]}
                labels={[
                  `${d.id}: ${t("hostMetrics.performance.activePercent")}`,
                ]}
                percent
              />
              <HistoryGraph
                points={points}
                keys={[`${d.id}:readBps`, `${d.id}:writeBps`]}
                labels={[
                  `${d.id}: ${t("hostMetrics.performance.readBps")}`,
                  `${d.id}: ${t("hostMetrics.performance.writeBps")}`,
                ]}
              />
            </>
          )}
        </div>
      ))}
    </section>
  );
}
const isLoopback = (i: { name: string; details?: { type?: string | null } }) =>
  i.details?.type === "loopback" || /^lo\d*$|^Loopback/i.test(i.name);
export function NetworkPerformance({
  metrics,
  hostId,
}: {
  metrics: ServerMetrics | null;
  hostId: number | null;
}) {
  const settings = useCardSettings(),
    { t } = useTranslation();
  const interfaces = (metrics?.network?.interfaces ?? []).filter(
    (i) => settings.showLoopback === true || !isLoopback(i),
  );
  const values: Record<string, number | null> = {};
  for (const i of interfaces) {
    values[`${i.name}:rx`] = i.rxRateBps ?? null;
    values[`${i.name}:tx`] = i.txRateBps ?? null;
  }
  const points = usePerformanceHistory(hostId, values, metrics?.lastChecked);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {interfaces.map((i) => (
        <section
          key={i.name}
          aria-label={`${i.name} ${t("hostMetrics.performance.adapterDetails")}`}
          className="flex min-w-0 flex-col gap-2"
        >
          <h4 className="break-words font-mono text-xs">{i.name}</h4>
          {settings.showLink !== false && (
            <DetailGrid
              data={i.details}
              fields={["model", "type", "linkMbps", "duplex", "mac"]}
            />
          )}
          {settings.showAddresses !== false && (
            <DetailGrid data={i.details} fields={["ipv4", "ipv6", "dns"]} />
          )}
          {settings.showActivity !== false && (
            <HistoryGraph
              points={points}
              keys={[`${i.name}:rx`, `${i.name}:tx`]}
              labels={[
                `${i.name}: ${t("hostMetrics.performance.receive")}`,
                `${i.name}: ${t("hostMetrics.performance.send")}`,
              ]}
            />
          )}
        </section>
      ))}
    </div>
  );
}
