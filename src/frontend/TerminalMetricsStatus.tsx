import { useEffect, useState } from "react";
import {
  usePluginApi,
  usePluginApiFor,
  useSettings,
  useTranslation,
} from "@termix-ssh/plugin-sdk/frontend";
import {
  getPollingEnvironmentMultiplier,
  resolveConnectionOrigin,
  resolveRemoteHostId,
  runAdaptivePolling,
} from "@termix-ssh/plugin-sdk/ui";
import type { DataResult } from "@termix-ssh/plugin-sdk/frontend";
import { liveIntervalMs, useLiveMetrics } from "./live-metrics";

/** What the ssh-terminal plugin hands a "terminal.toolbarStatus" component. */
interface TerminalToolbarStatusProps {
  host: {
    id: number | string;
    connectionOrigin?: "local" | "remote" | null;
    syncId?: string | null;
  };
  isConnected: boolean;
  /** Visible on a desktop viewport and connected: poll only while true. */
  active: boolean;
}

interface Sample {
  cpu: number | null;
  memory: number | null;
  disk: number | null;
}

/**
 * CPU, memory and disk bars for the terminal toolbar ("terminal.toolbarStatus",
 * a data slot keyed by tab). Polls only while the context says active.
 */
export function useTerminalStatusValue(
  context: Record<string, unknown>,
): DataResult {
  const props = context as unknown as Partial<TerminalToolbarStatusProps> & {
    hostId?: number | string;
  };
  const host =
    props.host ??
    (props.hostId !== undefined ? { id: props.hostId } : undefined);
  const active = props.active === true;
  const { t } = useTranslation();
  const localApi = usePluginApi();
  const remoteApi = usePluginApiFor("remote");
  const [metrics, setMetrics] = useState<Sample | null>(null);
  const [available, setAvailable] = useState(true);
  // The live endpoint only exists on this server, so it waits until the host is
  // known to be local rather than assuming it while the origin is resolved.
  // Keyed by host id, so switching hosts never inherits the previous host's answer.
  const [localHostId, setLocalHostId] = useState<number | null>(null);
  const hostId = host?.id ? Number(host.id) : null;
  const live = useLiveMetrics(
    hostId,
    active && available && hostId !== null && localHostId === hostId,
    liveIntervalMs(useSettings("user").values.liveInterval),
  );

  useEffect(() => {
    if (!active || !hostId) {
      setMetrics(null);
      return;
    }
    let cancelled = false;
    let stopPolling: (() => void) | undefined;
    let viewerSessionId: string | undefined;
    let previous: Sample | null = null;
    // A host on the desktop app's remote server has its own id there.
    let api = localApi;
    let targetId: number = hostId;
    setAvailable(true);
    setLocalHostId(null);

    const poll = async () => {
      try {
        const response = await api.get<{
          cpu?: { percent?: number };
          memory?: { percent?: number };
          disk?: { percent?: number };
        } | null>(`/metrics/${targetId}`, {
          validateStatus: (status: number) => status === 200 || status === 404,
        });
        const data = response.data;
        if (cancelled || !data) return;
        const next: Sample = {
          cpu: data.cpu?.percent ?? null,
          memory: data.memory?.percent ?? null,
          disk: data.disk?.percent ?? null,
        };
        const changed =
          !previous ||
          (["cpu", "memory", "disk"] as const).some((key) => {
            const before = previous?.[key];
            const now = next[key];
            return before == null || now == null || Math.abs(now - before) >= 2;
          });
        previous = next;
        setMetrics(next);
        return changed;
      } catch {
        // Keep the previous sample after a transient polling error.
        return false;
      }
    };

    const start = async () => {
      try {
        if ((await resolveConnectionOrigin(host)) === "remote") {
          const remoteId = await resolveRemoteHostId(host.syncId);
          if (cancelled) return;
          if (remoteId === null) {
            setAvailable(false);
            return;
          }
          api = remoteApi;
          targetId = remoteId;
        } else if (!cancelled) {
          setLocalHostId(hostId);
        }
        const { data } = await api.post<{
          requires_totp?: boolean;
          viewerSessionId?: string;
        }>(`/metrics/start/${targetId}`);
        if (cancelled) {
          if (data.viewerSessionId) {
            void api
              .post(`/metrics/stop/${targetId}`, {
                viewerSessionId: data.viewerSessionId,
              })
              .catch(() => {});
          }
          return;
        }
        if (data.requires_totp) {
          setAvailable(false);
          return;
        }
        viewerSessionId = data.viewerSessionId;
        stopPolling = runAdaptivePolling(
          poll,
          {
            minIntervalMs: 5_000,
            maxIntervalMs: 20_000,
            stablePollsPerStep: 2,
            maxRequestDutyCycle: 0.2,
          },
          { intervalMultiplier: getPollingEnvironmentMultiplier },
        );
      } catch {
        if (!cancelled) setAvailable(false);
      }
    };
    void start();

    return () => {
      cancelled = true;
      stopPolling?.();
      void api
        .post(`/metrics/stop/${targetId}`, { viewerSessionId })
        .catch(() => {});
    };
  }, [active, hostId, localApi, remoteApi]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!available) {
    return {
      shape: "text",
      text: t("terminalStatus.unavailable"),
      tone: "muted",
    };
  }

  // The live sample overrides CPU and memory; disk is not in it and keeps the regular value.
  const cpu = live?.cpu ?? metrics?.cpu ?? null;
  const memory = live?.memTotalKb
    ? (live.memUsedKb / live.memTotalKb) * 100
    : (metrics?.memory ?? null);

  const share = (percent: number | null) =>
    percent == null ? null : Math.max(0, Math.min(100, percent)) / 100;
  return {
    shape: "bars",
    items: [
      { label: t("hostMetrics.cpu"), value: share(cpu) },
      { label: t("hostMetrics.memory"), value: share(memory) },
      { label: t("hostMetrics.disk"), value: share(metrics?.disk ?? null) },
    ],
  };
}
