import { useEffect, useState } from "react";
import { ArrowDownUp } from "lucide-react";
import { MetricCard, LoadingState } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import type { ServerMetrics } from "../../shared/metrics.js";
import { useHostMetricsApi, type MetricsHistoryRow } from "../host-metrics-api";
import { chartHeight, useCardSettings } from "../card-settings";
import { SmoothLineChart as LineChart } from "./SmoothCharts";
import { CardTimeTabs, type HistoryTab } from "./CardTimeTabs";
import { LiveUsage } from "./LiveUsage";

function capacity(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(2)} KiB`;
  return `${bytes} B`;
}

export function SwapCard({
  metrics,
  history,
  timestamps = [],
  hostId,
}: {
  metrics: ServerMetrics | null;
  history: Array<number | null>;
  timestamps?: string[];
  hostId: number | null;
}) {
  const { t } = useTranslation();
  const { getMetricsHistory } = useHostMetricsApi();
  const settings = useCardSettings();
  const [activeTab, setActiveTab] = useState<HistoryTab>("live");
  const [result, setResult] = useState<{
    hostId: number;
    range: HistoryTab;
    rows: MetricsHistoryRow[] | null;
    failed: boolean;
  } | null>(null);
  const current =
    result?.hostId === hostId && result?.range === activeTab ? result : null;
  const rows = current?.rows ?? null;
  const failed = current?.failed ?? false;
  const loading = activeTab !== "live" && hostId != null && !current;

  useEffect(() => {
    if (activeTab === "live" || hostId == null) return;
    let cancelled = false;
    setResult(null);
    getMetricsHistory(hostId, { range: activeTab })
      .then((response) => {
        if (!cancelled)
          setResult({
            hostId,
            range: activeTab,
            rows: response.rows,
            failed: false,
          });
      })
      .catch(() => {
        if (!cancelled)
          setResult({ hostId, range: activeTab, rows: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [hostId, activeTab, getMetricsHistory]);

  const swap = metrics?.swap;
  const hasHistory = rows?.some((row) => row.swap_percent != null);
  return (
    <MetricCard
      title={t("hostMetrics.swapUsage")}
      icon={<ArrowDownUp className="size-3.5" />}
      scroll={activeTab === "live"}
      action={
        hostId != null ? (
          <CardTimeTabs value={activeTab} onChange={setActiveTab} />
        ) : undefined
      }
    >
      {activeTab === "live" ? (
        swap == null ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("hostMetrics.swapUnavailable")}
          </p>
        ) : swap.totalBytes === 0 ? (
          <p role="status" className="text-xs text-muted-foreground">
            {t("hostMetrics.swapNone")}
          </p>
        ) : (
          <LiveUsage
            percent={swap.percent}
            label={t("hostMetrics.swapUsage")}
            stats={
              settings.showDetails === false
                ? []
                : [
                    {
                      caption: t("hostMetrics.swapUsed"),
                      value: capacity(swap.usedBytes),
                    },
                    {
                      caption: t("hostMetrics.swapTotal"),
                      value: capacity(swap.totalBytes),
                    },
                    {
                      caption: t("hostMetrics.free"),
                      value: capacity(swap.freeBytes),
                    },
                  ]
            }
            color="var(--chart-4)"
            points={history}
            timestamps={timestamps}
            chartHeight={chartHeight(settings, 110)}
          />
        )
      ) : (
        <div className="flex flex-col gap-3">
          {loading && <LoadingState compact label={t("common.loading")} />}
          {failed && (
            <p role="alert" className="text-xs text-destructive">
              {t("hostMetrics.swapHistoryFailed")}
            </p>
          )}
          {!loading && !failed && rows !== null && !hasHistory && (
            <p className="text-xs text-muted-foreground">
              {t("metricsHistory.noData")}
            </p>
          )}
          {!loading && !failed && hasHistory && (
            <LineChart
              series={[
                {
                  key: "swap",
                  label: t("hostMetrics.swapUsage"),
                  color: "var(--chart-4)",
                  data: rows?.map((row) => row.swap_percent ?? null) ?? [],
                },
              ]}
              timestamps={rows?.map((row) => row.ts) ?? []}
              domain={[0, 100]}
              yFormatter={(value) => `${value.toFixed(0)}%`}
              height={chartHeight(settings, 160)}
            />
          )}
        </div>
      )}
    </MetricCard>
  );
}
