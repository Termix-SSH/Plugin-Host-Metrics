import { SmoothLineChart as LineChart } from "./SmoothCharts";
import { MemoryPerformance } from "./PerformanceDetails";
import { useCardSettings, chartHeight } from "../card-settings";
import { MetricCard, type LineChartSeries } from "@termix-ssh/plugin-sdk/ui";
import { type ServerMetrics } from "../../shared/metrics.js";
import { useState, useEffect } from "react";
import { MemoryStick } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { type MetricsHistoryRow, useHostMetricsApi } from "../host-metrics-api";
import { CardTimeTabs, type HistoryTab } from "./CardTimeTabs";
import { memParts } from "../live-metrics";
import { LiveUsage } from "./LiveUsage";

export function MemoryCard({
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

  const percent = metrics?.memory?.percent ?? null;
  const usedGiB = metrics?.memory?.usedGiB ?? null;
  const totalGiB = metrics?.memory?.totalGiB ?? null;
  const freeGiB =
    usedGiB !== null && totalGiB !== null ? totalGiB - usedGiB : null;
  const parts =
    totalGiB && metrics?.memory?.freeGiB != null
      ? memParts(
          totalGiB,
          metrics.memory.freeGiB,
          metrics.memory.cachedGiB ?? 0,
        )
      : null;

  const series: LineChartSeries[] = [
    {
      key: "mem",
      label: t("hostMetrics.memoryUsage"),
      color: "var(--chart-3)",
      data: rows?.map((r) => r.mem_percent) ?? [],
    },
  ];
  const timestamps = rows?.map((r) => r.ts) ?? [];

  return (
    <MetricCard
      scroll={activeTab === "live"}
      title={t("hostMetrics.memoryUsage")}
      icon={<MemoryStick className="size-3.5" />}
      action={
        hostId != null ? (
          <CardTimeTabs value={activeTab} onChange={setActiveTab} />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {activeTab === "live" && (
          <LiveUsage
            percent={percent}
            stats={
              settings.showDetails !== false
                ? [
                    ...(usedGiB !== null && totalGiB !== null
                      ? [
                          {
                            caption: t("hostMetrics.memory"),
                            value: `${usedGiB.toFixed(1)}/${totalGiB.toFixed(1)}G`,
                          },
                        ]
                      : []),
                    ...(freeGiB !== null
                      ? [
                          {
                            caption: t("hostMetrics.free"),
                            value: `${freeGiB.toFixed(1)}G`,
                          },
                        ]
                      : []),
                  ]
                : []
            }
            label={t("hostMetrics.memoryUsage")}
            color="var(--chart-3)"
            points={history}
            timestamps={liveTimes}
            chartHeight={chartHeight(settings, 110)}
          >
            {settings.showBreakdown !== false &&
              parts &&
              metrics?.memory?.cachedGiB != null && (
                <div className="flex flex-col gap-0.5">
                  <div className="flex h-1.5 w-full bg-muted">
                    <div
                      className="bg-accent-brand"
                      style={{ width: `${parts.used}%` }}
                    />
                    <div
                      className="bg-accent-brand/40"
                      style={{ width: `${parts.cache}%` }}
                    />
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {t("hostMetrics.memoryMix", {
                      cache: metrics.memory.cachedGiB.toFixed(1),
                    })}
                  </div>
                </div>
              )}
          </LiveUsage>
        )}
        {activeTab === "live" && <MemoryPerformance metrics={metrics} />}
        {activeTab !== "live" && (
          <>
            {loading && (
              <div className="flex h-36 items-center justify-center text-xs text-muted-foreground">
                {t("common.loading")}
              </div>
            )}
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
