import { useCallback, useEffect, useRef, useState } from "react";
import {
  useTranslation,
  type TranslateFn,
} from "@termix-ssh/plugin-sdk/frontend";
import { useHostMetricsApi } from "../../host-metrics-api";

interface ManagerError {
  message: string;
  code?: string;
}

/** Set when the server refuses a change because the user lacks edit access. */
export const HOST_EDIT_REQUIRED = "HOST_EDIT_REQUIRED";

function extractError(err: unknown, t?: TranslateFn): ManagerError {
  const e = err as {
    response?: { data?: { error?: string; code?: string } };
    message?: string;
  };
  const code = e?.response?.data?.code;
  if (code === HOST_EDIT_REQUIRED && t) {
    return { message: t("hostMetrics.managers.editRequired"), code };
  }
  return {
    message: e?.response?.data?.error || e?.message || "Request failed",
    code,
  };
}

/**
 * Fetch a manager read resource on mount + manual refresh, with loading/error
 * state. `hostId` null disables fetching.
 */
export function useManagerData<T>(
  hostId: number | null,
  resource: string,
  params?: Record<string, string | number>,
) {
  const { managerGet } = useHostMetricsApi();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ManagerError | null>(null);

  const generation = useRef(0);
  const paramsKey = params ? JSON.stringify(params) : "";

  const refresh = useCallback(async () => {
    if (hostId == null) return;
    const request = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const res = await managerGet<T>(hostId, resource, params);
      if (request === generation.current) setData(res);
    } catch (err) {
      if (request === generation.current) {
        setData(null);
        setError(extractError(err));
      }
    } finally {
      if (request === generation.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, resource, paramsKey]);

  useEffect(() => {
    setData(null);
    setError(null);
    setLoading(false);
    refresh();
    return () => {
      generation.current++;
    };
  }, [refresh]);

  return { data, loading, error, refresh, setData };
}

export { extractError };
export type { ManagerError };
