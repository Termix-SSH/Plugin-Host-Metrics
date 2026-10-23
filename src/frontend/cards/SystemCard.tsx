import { useCardSettings } from "../card-settings";
import { StatRow, MetricCard } from "@termix-ssh/plugin-sdk/ui";
import { type ServerMetrics } from "../../shared/metrics.js";
import { Server } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";

export function SystemCard({ metrics }: { metrics: ServerMetrics | null }) {
  const { t } = useTranslation();
  const settings = useCardSettings();
  const system = metrics?.system;
  const uptime = metrics?.uptime;

  const rows = [
    { label: t("hostMetrics.hostname"), value: system?.hostname },
    { label: t("hostMetrics.operatingSystem"), value: system?.os },
    { label: t("hostMetrics.kernel"), value: system?.kernel },
    { label: t("hostMetrics.architecture"), value: system?.arch },
    { label: t("hostMetrics.uptime"), value: uptime?.formatted },
  ].filter((r, i) => r.value && (settings.showDetails !== false || i < 2));

  return (
    <MetricCard
      title={t("hostMetrics.systemInfo")}
      icon={<Server className="size-3.5" />}
      scroll
    >
      {rows.length === 0 ? null : (
        <div className="flex flex-col divide-y divide-border">
          {rows.map(({ label, value }) => (
            <StatRow key={label} label={label} value={value} mono />
          ))}
        </div>
      )}
    </MetricCard>
  );
}
