import type { ComponentType } from "react";
import {
  useSettings,
  useTranslation,
  type PluginHostRecord,
} from "@termix-ssh/plugin-sdk/frontend";
import { readHostMetricsSettings } from "../shared/stats-widgets.js";
import type { HostMetricsCardId } from "../shared/host-metrics.js";
import { CARD_DEFINITIONS } from "./cards";
import type { HostMetricsApi } from "./host-metrics-api";
import { useMetricsFeed } from "./metrics-feed";
import { liveIntervalMs } from "./live-metrics";

/** Cards offered as host page tiles, with no history to load first. */
export const HOST_PAGE_CARDS: HostMetricsCardId[] = [
  "cpu",
  "memory",
  "swap",
  "disk",
  "network",
  "uptime",
  "system",
  "processes",
  "ports",
];

interface TileProps {
  hostId: number;
  host?: PluginHostRecord;
  isVisible?: boolean;
}

/** One Host Metrics card as a host page tile, fed by the shared collection. */
export function createHostPageTile(
  api: HostMetricsApi,
  cardId: HostMetricsCardId,
): ComponentType<TileProps> {
  function HostPageMetricTile({ hostId, host, isVisible = true }: TileProps) {
    const { t } = useTranslation();
    const settings = readHostMetricsSettings(
      (host as { pluginSettings?: Record<string, Record<string, unknown>> })
        ?.pluginSettings?.["host-metrics"],
    );
    const enabled = settings.metricsEnabled !== false;
    const intervalMs = Math.max(5, settings.metricsInterval ?? 15) * 1000;
    const liveMs = liveIntervalMs(useSettings("user").values.liveInterval);
    const { metrics, histories, state } = useMetricsFeed(
      api,
      hostId,
      isVisible && enabled,
      intervalMs,
      liveMs,
    );
    const def = CARD_DEFINITIONS[cardId];
    if (!enabled || state === "totp" || (state === "failed" && !metrics)) {
      return (
        <div className="flex h-full flex-col p-3 text-xs text-muted-foreground">
          {!enabled
            ? t("hostMetrics.companion.off")
            : state === "totp"
              ? t("hostMetrics.hostPage.totp")
              : t("hostMetrics.hostPage.failed")}
        </div>
      );
    }
    return (
      <div className="h-full [&>div]:h-full">
        {def.render({ metrics, histories, hostId })}
      </div>
    );
  }
  return HostPageMetricTile;
}
