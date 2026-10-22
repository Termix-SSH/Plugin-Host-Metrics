import { useCallback, useEffect, useState } from "react";
import {
  useHosts,
  usePermission,
  useTabs,
  useTranslation,
  type DashboardCardProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { ListRow, PanelList } from "@termix-ssh/plugin-sdk/ui";
import type { HostMetricsApi, MetricsSummaryRow } from "./host-metrics-api";
import { RowBar } from "./SummaryViews";

const LIMIT = 8;
const POLL_MS = 30_000;

/** The highest of CPU and memory, which decides the order. */
export function loadOf(row: MetricsSummaryRow): number {
  return Math.max(row.cpu ?? 0, row.memory ?? 0);
}

/** Dashboard card: the hosts working hardest, from samples already taken. */
export function createBusiestHostsCard(api: HostMetricsApi) {
  return function BusiestHostsCard({ isVisible }: DashboardCardProps) {
    const { t } = useTranslation();
    const allowed = usePermission("use");
    const tabs = useTabs();
    const { hosts } = useHosts();
    const [rows, setRows] = useState<MetricsSummaryRow[] | null>(null);

    const load = useCallback(async () => {
      try {
        setRows(await api.summary());
      } catch {
        setRows([]);
      }
    }, []);

    useEffect(() => {
      if (!isVisible || !allowed) return;
      void load();
      const timer = setInterval(() => void load(), POLL_MS);
      return () => clearInterval(timer);
    }, [isVisible, allowed, load]);

    if (!allowed) return null;
    if (!rows) {
      return (
        <p className="p-3 text-xs text-muted-foreground">{t("card.loading")}</p>
      );
    }

    const busiest = rows
      .filter((row) => hosts.some((h) => Number(h.id) === row.hostId))
      .sort((a, b) => loadOf(b) - loadOf(a))
      .slice(0, LIMIT);

    return (
      <PanelList
        empty={
          <p className="p-3 text-xs text-muted-foreground">{t("card.empty")}</p>
        }
      >
        {busiest.map((row, index) => {
          const host = hosts.find((h) => Number(h.id) === row.hostId)!;
          return (
            <ListRow
              key={row.hostId}
              stripe={index}
              tone={
                loadOf(row) >= 90
                  ? "destructive"
                  : loadOf(row) >= 70
                    ? "warning"
                    : "none"
              }
              title={host.name || host.ip}
              trailing={
                <div className="flex items-center gap-2 pr-2">
                  {row.cpu !== null && (
                    <RowBar label={t("dashboard.cpu")} value={row.cpu} />
                  )}
                  {row.memory !== null && (
                    <RowBar label={t("dashboard.ram")} value={row.memory} />
                  )}
                  {row.disk !== null && (
                    <RowBar label={t("dashboardTab.disk")} value={row.disk} />
                  )}
                </div>
              }
              onClick={() => tabs.openTab(host, "host-metrics")}
            />
          );
        })}
      </PanelList>
    );
  };
}
