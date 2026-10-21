import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  useSettings,
  useTabs,
  useTranslation,
  type CompanionDefaults,
  type CompanionProps,
} from "@termix-ssh/plugin-sdk/frontend";
import { readHostMetricsSettings } from "../shared/stats-widgets.js";
import type { ServerMetrics } from "../shared/metrics.js";
import { useHostMetricsApi } from "./host-metrics-api";
import { compactRows } from "./compact-metrics";

/** Starting state of the panel, from the user's settings. */
export function useMetricsCompanionDefaults(): CompanionDefaults {
  const { values } = useSettings("user");
  const side = values.companionSide;
  return {
    open: values.companionAutoOpen === true,
    side: side === "left" || side === "bottom" ? side : "right",
    size: typeof values.companionSize === "number" ? values.companionSize : 300,
    edgeButton: values.companionEdgeButton !== false,
  };
}

function Bar({ percent }: { percent: number | null }) {
  const value = percent == null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="h-1.5 w-full bg-muted">
      <div
        className={`h-full ${value >= 90 ? "bg-destructive" : value >= 75 ? "bg-warning" : "bg-accent-brand"}`}
        style={{ width: `${value}%` }}
      />
    </div>
  );
}

export function HostMetricsCompanion({ host, isVisible }: CompanionProps) {
  const { t } = useTranslation();
  const api = useHostMetricsApi();
  const tabs = useTabs();
  const { values: userValues } = useSettings("user");
  const fahrenheit = userValues.temperatureUnit === "fahrenheit";
  const hostId = host ? Number(host.id) : null;
  const settings = readHostMetricsSettings(
    (host as { pluginSettings?: Record<string, Record<string, unknown>> })
      ?.pluginSettings?.["host-metrics"],
  );
  const intervalMs = Math.max(5, settings.metricsInterval ?? 15) * 1000;
  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [error, setError] = useState<"failed" | "totp" | null>(null);
  const [loading, setLoading] = useState(false);
  const viewerRef = useRef<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (hostId == null) return;
    try {
      const data = await api.getMetrics(hostId);
      if (data) {
        setMetrics(data);
        setError(null);
      }
    } catch {
      setError("failed");
    }
  }, [api, hostId]);

  // Collects while the panel is showing, and lets go when it is not.
  useEffect(() => {
    if (!isVisible || hostId == null || settings.metricsEnabled === false) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let beat: ReturnType<typeof setInterval> | undefined;
    setLoading(true);
    void (async () => {
      try {
        const started = await api.startMetrics(hostId);
        if (cancelled) return;
        if (started.requires_totp) {
          setError("totp");
          return;
        }
        viewerRef.current = started.viewerSessionId;
        for (let i = 0; i < 6 && !cancelled; i++) {
          const data = await api.getMetrics(hostId);
          if (data) {
            setMetrics(data);
            setError(null);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        if (cancelled) return;
        timer = setInterval(() => void refresh(), intervalMs);
        beat = setInterval(() => {
          if (viewerRef.current) {
            api.heartbeat(viewerRef.current).catch(() => {});
          }
        }, 30000);
      } catch {
        if (!cancelled) setError("failed");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      if (beat) clearInterval(beat);
      api.stopMetrics(hostId, viewerRef.current).catch(() => {});
      viewerRef.current = undefined;
    };
  }, [api, hostId, isVisible, intervalMs, settings.metricsEnabled, refresh]);

  if (settings.metricsEnabled === false) {
    return (
      <p className="p-3 text-xs text-muted-foreground">
        {t("hostMetrics.companion.off")}
      </p>
    );
  }

  const rows = metrics ? compactRows(metrics, fahrenheit) : [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-2 py-1">
        <span className="truncate text-[10px] text-muted-foreground">
          {metrics?.system?.hostname ?? ""}
        </span>
        <button
          type="button"
          className="p-1 text-muted-foreground hover:text-foreground"
          title={t("hostMetrics.refresh")}
          onClick={() => void refresh()}
        >
          <RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {error === "totp" && (
          <div className="flex flex-col gap-2 text-xs">
            <p className="text-muted-foreground">
              {t("hostMetrics.companion.totp")}
            </p>
            {host && (
              <button
                type="button"
                className="self-start border border-border px-2 py-1 hover:bg-muted"
                onClick={() => tabs.openTab(host as never, "host-metrics")}
              >
                {t("hostMetrics.companion.open")}
              </button>
            )}
          </div>
        )}
        {error === "failed" && !metrics && (
          <p className="text-xs text-destructive">
            {t("hostMetrics.connectionFailed")}
          </p>
        )}
        {!metrics && !error && (
          <p className="text-xs text-muted-foreground">
            {t("hostMetrics.companion.loading")}
          </p>
        )}
        {rows.length > 0 && (
          <div className="flex flex-col gap-2.5">
            {rows.map((row) => (
              <div key={row.id} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium">{t(row.labelKey)}</span>
                  <span className="truncate font-mono text-muted-foreground">
                    {row.value}
                  </span>
                </div>
                {row.percent !== undefined && <Bar percent={row.percent} />}
                {row.detail && (
                  <span className="truncate text-[10px] text-muted-foreground">
                    {row.detail}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {metrics?.processes?.top && metrics.processes.top.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("hostMetrics.companion.topProcesses")}
            </span>
            {metrics.processes.top.slice(0, 5).map((proc) => (
              <div
                key={proc.pid}
                className="flex items-center justify-between gap-2 text-[11px]"
              >
                <span className="min-w-0 truncate font-mono">
                  {proc.command.split(" ")[0].split("/").pop()}
                </span>
                <span className="shrink-0 font-mono text-muted-foreground">
                  {proc.cpu}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
