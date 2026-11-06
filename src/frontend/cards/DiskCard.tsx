import { SmoothLineChart as LineChart } from "./SmoothCharts";
import { DiskPerformance } from "./PerformanceDetails";
import { useCardSettings, chartHeight } from "../card-settings";
import {
  MetricCard,
  type LineChartSeries,
  LoadingState,
} from "@termix-ssh/plugin-sdk/ui";
import { LiveUsage } from "./LiveUsage";
import { type ServerMetrics } from "../../shared/metrics.js";
import { useState, useEffect, useMemo } from "react";
import { HardDrive } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { FilesystemPicker } from "./FilesystemPicker";
import { type MetricsHistoryRow, useHostMetricsApi } from "../host-metrics-api";
import { CardTimeTabs, type HistoryTab } from "./CardTimeTabs";

export function DiskCard({
  metrics,
  history,
  timestamps: liveTimes = [],
  hostId,
}: {
  metrics: ServerMetrics | null;
  history: Array<number | null>;
  /** When each history point was taken. */
  timestamps?: string[];
  hostId: number | null;
}) {
  const { getMetricsHistory } = useHostMetricsApi();
  const { t } = useTranslation();
  const settings = useCardSettings();
  const [activeTab, setActiveTab] = useState<HistoryTab>("live");
  const [rows, setRows] = useState<MetricsHistoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (activeTab === "live" || hostId == null) return;
    let cancelled = false;
    setLoading(true);
    setRows(null);
    getMetricsHistory(hostId, { range: activeTab })
      .then((res) => {
        if (!cancelled) {
          setRows(res.rows);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab, hostId]);

  const filesystems = useMemo(
    () => metrics?.disk?.filesystems ?? [],
    [metrics?.disk?.filesystems],
  );
  const defaultMount = metrics?.disk?.mount ?? null;
  const [selectedMount, setSelectedMount] = useState<string | null>(null);

  // Drop a stale selection if the mount disappears between polls, so the card
  // falls back to the primary filesystem instead of rendering nothing.
  useEffect(() => {
    if (
      selectedMount !== null &&
      filesystems.length > 0 &&
      !filesystems.some((fs) => fs.mount === selectedMount)
    ) {
      setSelectedMount(null);
    }
  }, [filesystems, selectedMount]);

  const activeMount = selectedMount ?? defaultMount;
  const activeFs = filesystems.find((fs) => fs.mount === activeMount) ?? null;
  const isCustomMount = selectedMount !== null && activeFs !== null;

  const percent = isCustomMount
    ? activeFs.percent
    : (metrics?.disk?.percent ?? null);
  const usedHuman = isCustomMount
    ? activeFs.usedHuman
    : (metrics?.disk?.usedHuman ?? null);
  const totalHuman = isCustomMount
    ? activeFs.totalHuman
    : (metrics?.disk?.totalHuman ?? null);
  const availableHuman = isCustomMount
    ? activeFs.availableHuman
    : (metrics?.disk?.availableHuman ?? null);

  const series: LineChartSeries[] = [
    {
      key: "disk",
      label: t("hostMetrics.diskUsage"),
      color: "var(--chart-4)",
      data: rows?.map((r) => r.disk_percent) ?? [],
    },
  ];
  const timestamps = rows?.map((r) => r.ts) ?? [];

  return (
    <MetricCard
      scroll={activeTab === "live"}
      title={t("hostMetrics.diskUsage")}
      icon={<HardDrive className="size-3.5" />}
      action={
        <div className="flex items-center gap-1.5">
          {activeTab === "live" && (
            <FilesystemPicker
              filesystems={filesystems}
              value={activeMount}
              onChange={setSelectedMount}
            />
          )}
          {hostId != null && (
            <CardTimeTabs value={activeTab} onChange={setActiveTab} />
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {activeTab === "live" && (
          <LiveUsage
            percent={percent}
            caption={activeMount ?? undefined}
            stats={
              settings.showDetails !== false
                ? [
                    ...(usedHuman && totalHuman
                      ? [
                          {
                            caption: t("hostMetrics.disk"),
                            value: `${usedHuman}/${totalHuman}`,
                          },
                        ]
                      : []),
                    ...(availableHuman
                      ? [
                          {
                            caption: t("hostMetrics.available"),
                            value: availableHuman,
                          },
                        ]
                      : []),
                  ]
                : []
            }
            label={t("hostMetrics.diskUsage")}
            color="var(--chart-4)"
            points={isCustomMount ? [] : history}
            timestamps={isCustomMount ? [] : liveTimes}
            chartHeight={chartHeight(settings, 80)}
          />
        )}
        {activeTab === "live" && (
          <DiskPerformance metrics={metrics} hostId={hostId} />
        )}
        {activeTab !== "live" && (
          <>
            {loading && <LoadingState compact label={t("common.loading")} />}
            {!loading && rows !== null && rows.length === 0 && (
              <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">
                {t("metricsHistory.noData")}
              </div>
            )}
            {!loading && rows !== null && rows.length > 0 && (
              <LineChart
                series={series}
                timestamps={timestamps}
                domain={[0, 100]}
                yFormatter={(v) => `${v.toFixed(0)}%`}
                height={chartHeight(settings, 160)}
              />
            )}
          </>
        )}
      </div>
    </MetricCard>
  );
}
