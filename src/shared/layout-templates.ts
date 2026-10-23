import { sanitizeLayout, type HostMetricsLayout } from "./host-metrics.js";

export interface LayoutTemplate {
  id: number;
  name: string;
  layout: HostMetricsLayout;
}

export interface LayoutTemplateHost {
  id: number;
  name: string;
  folder: string | null;
}

export interface LayoutTemplateApplyResult {
  hostId: number;
  applied: boolean;
  error?: string;
}

export const MAX_TEMPLATE_HOSTS = 100;
export const MAX_TEMPLATES = 50;

/** Use the preferences format, including contributed card IDs, not host settings. */
export function templateLayout(input: unknown): HostMetricsLayout | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Record<string, unknown>;
  if (
    !Number.isInteger(value.columns) ||
    Number(value.columns) < 1 ||
    Number(value.columns) > 4 ||
    !Array.isArray(value.slots) ||
    value.slots.length > 100 ||
    JSON.stringify(value).length > 65_536
  )
    return null;
  const layout = sanitizeLayout(value);
  if (
    !layout ||
    layout.slots.length !== value.slots.length ||
    layout.slots.some((slot) => slot.id.length > 128)
  )
    return null;
  return layout;
}
