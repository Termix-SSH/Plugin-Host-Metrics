import {
  RadialGauge,
  Sparkline,
  MiniStat,
  MetricCard,
  LineChart,
  type LineChartSeries,
} from "@termix-ssh/plugin-sdk/ui";
import { type ServerMetrics } from "../../shared/metrics.js";
import { useState, useEffect } from "react";
import { Cpu } from "lucide-react";
import { loadColor } from "../process-view";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { type MetricsHistoryRow, useHostMetricsApi } from "../host-metrics-api";
import { CardTimeTabs, type HistoryTab } from "./CardTimeTabs";

export function CpuCard({
  metrics,
  history,
  hostId,
}: {
  metrics: ServerMetrics | null;
  history: number[];
  hostId: number | null;
}) {
  const { getMetricsHistory } = useHostMetricsApi();
  const { t } = useTranslation();
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

  const percent = metrics?.cpu?.percent ?? null;
  const cores = metrics?.cpu?.cores ?? null;
  const load = metrics?.cpu?.load ?? null;

  const series: LineChartSeries[] = [
    {
      key: "cpu",
      label: t("hostMetrics.cpuUsage"),
      color: "var(--accent-brand)",
      data: rows?.map((r) => r.cpu_percent) ?? [],
    },
  ];
  const timestamps = rows?.map((r) => r.ts) ?? [];

  return (
    <MetricCard
      title={t("hostMetrics.cpuUsage")}
      icon={<Cpu className="size-3.5" />}
      action={
        hostId != null ? (
          <CardTimeTabs value={activeTab} onChange={setActiveTab} />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {activeTab === "live" && (
          <div className="flex items-center gap-4">
            <RadialGauge
              value={percent}
              caption={
                cores !== null
                  ? t("hostMetrics.cpuCores", { count: cores })
                  : undefined
              }
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              {load && (
                <div className="grid grid-cols-3 gap-2">
                  <MiniStat caption="1m" value={load[0].toFixed(2)} />
                  <MiniStat caption="5m" value={load[1].toFixed(2)} />
                  <MiniStat caption="15m" value={load[2].toFixed(2)} />
                </div>
              )}
              <Sparkline
                data={[...history, percent ?? 0]}
                domain={[0, 100]}
                height={48}
              />
              {metrics?.cpu?.mix && (
                <div className="flex flex-col gap-0.5">
                  <div className="flex h-1.5 w-full bg-muted">
                    <div
                      className="bg-emerald-500"
                      style={{ width: `${metrics.cpu.mix.user}%` }}
                    />
                    <div
                      className="bg-red-500"
                      style={{ width: `${metrics.cpu.mix.system}%` }}
                    />
                    <div
                      className="bg-sky-500"
                      style={{ width: `${metrics.cpu.mix.iowait}%` }}
                    />
                    <div
                      className="bg-purple-500"
                      style={{ width: `${metrics.cpu.mix.steal}%` }}
                    />
                  </div>
                  <div className="font-mono text-[10px] text-muted-foreground">
                    {t("hostMetrics.cpuMix", {
                      user: metrics.cpu.mix.user.toFixed(0),
                      system: metrics.cpu.mix.system.toFixed(0),
                      iowait: metrics.cpu.mix.iowait.toFixed(0),
                      steal: metrics.cpu.mix.steal.toFixed(0),
                    })}
                  </div>
                </div>
              )}
              {metrics?.cpu?.perCore && metrics.cpu.perCore.length > 0 && (
                <div className="flex flex-col gap-0.5">
                  {metrics.cpu.perCore.map((c, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground"
                    >
                      <span className="w-5 shrink-0">
                        #{metrics.cpu.coreIds?.[i] ?? i}
                      </span>
                      <div className="h-1.5 flex-1 bg-muted">
                        <div
                          className={"h-full " + loadColor(c)}
                          style={{ width: `${c ?? 0}%` }}
                        />
                      </div>
                      <span className="w-7 shrink-0 text-right">
                        {c == null ? "-" : `${c.toFixed(0)}%`}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
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
                height={160}
              />
            )}
          </>
        )}
      </div>
    </MetricCard>
  );
}
