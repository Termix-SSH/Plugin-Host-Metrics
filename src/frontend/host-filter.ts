/** This plugin's metricsEnabled host setting; on unless turned off. */
export function metricsEnabledFor(host: unknown): boolean {
  const bag = (
    host as { pluginSettings?: Record<string, Record<string, unknown>> }
  )?.pluginSettings;
  return bag?.["host-metrics"]?.metricsEnabled !== false;
}

/** Metrics come over SSH, so a host without it has none to show. */
export function hostHasMetrics(host: unknown): boolean {
  if (!host) return true;
  if ((host as { enableSsh?: boolean }).enableSsh === false) return false;
  return metricsEnabledFor(host);
}
