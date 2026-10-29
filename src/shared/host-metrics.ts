import type { WidgetType } from "./stats-widgets.js";

/**
 * Host Metrics layout model. Shared by the frontend tab and the backend
 * preferences endpoint. Metric card ids reuse the existing `WidgetType` values
 * verbatim (so `enabledWidgets` stays valid for the mobile app); manager card
 * ids are new and never enter the `enabledWidgets` host setting.
 */

export type HostMetricCardId = WidgetType;

export type HostMetricManagerId =
  | "service_manager"
  | "process_inspector"
  | "log_viewer"
  | "cron_manager"
  | "package_manager"
  | "ssl_manager"
  | "firewall_manager"
  | "user_manager"
  | "health_check"
  | "disk_breakdown"
  | "systemd_timers"
  | "top_memory"
  | "wireguard_manager"
  | "tailscale_manager";

export type HostMetricsCardId = HostMetricCardId | HostMetricManagerId;

export type HostMetricsColSpan = 1 | 2 | 3;

interface HostMetricsSlot {
  id: HostMetricsCardId;
  order: number;
  colSpan: HostMetricsColSpan;
  height: number | null;
  /** Legacy CSS-pixel width, only read when `w` is missing. */
  width?: number;
  /** Grid position: column, top in px, width in columns of GRID_COLUMNS. */
  x?: number;
  y?: number;
  w?: number;
  settings?: HostMetricsCardSettings;
}

export const MIN_CARD_WIDTH = 280;
export const MAX_CARD_WIDTH = 8192;
export const GRID_COLUMNS = 12;
export const MIN_CARD_COLUMNS = 2;

export interface HostMetricsLayout {
  slots: HostMetricsSlot[];
  columns: number;
}

/** Canonical order of metric cards (also the canonical `enabledWidgets` order). */
export const METRIC_CARD_IDS: HostMetricCardId[] = [
  "cpu",
  "memory",
  "disk",
  "network",
  "uptime",
  "system",
  "login_stats",
  "processes",
  "ports",
  "firewall",
  "temperature",
  "gpu",
];

const MANAGER_CARD_IDS: HostMetricManagerId[] = [
  "service_manager",
  "process_inspector",
  "log_viewer",
  "cron_manager",
  "package_manager",
  "ssl_manager",
  "firewall_manager",
  "user_manager",
  "health_check",
  "disk_breakdown",
  "systemd_timers",
  "top_memory",
  "wireguard_manager",
  "tailscale_manager",
];

export function isMetricCardId(id: string): id is HostMetricCardId {
  return (METRIC_CARD_IDS as string[]).includes(id);
}

export function isManagerCardId(id: string): id is HostMetricManagerId {
  return (MANAGER_CARD_IDS as string[]).includes(id);
}

/**
 * Derive the flat `enabledWidgets` array (canonical order, deduped, metric ids
 * only) from a set of layout slots. This is the single source of truth keeping
 * the `enabledWidgets` host setting valid for the mobile app.
 */
export function deriveEnabledWidgets(
  slots: Array<{ id: string }>,
): WidgetType[] {
  const present = new Set(slots.map((s) => s.id));
  return METRIC_CARD_IDS.filter((id) => present.has(id));
}

const DEFAULT_COLSPAN: Partial<Record<HostMetricsCardId, HostMetricsColSpan>> =
  {
    cpu: 1,
    memory: 1,
    disk: 1,
    uptime: 1,
    system: 1,
    network: 1,
    temperature: 1,
    processes: 2,
    ports: 2,
    firewall: 2,
    login_stats: 2,
    gpu: 2,
  };

// All cards default to content/auto height (null); the masonry packs them
// tetris-style and scrollable cards cap their auto-height body. Pinned cards
// use the available body space, set by the size controls or resize handle.
const DEFAULT_HEIGHT: Partial<Record<HostMetricsCardId, number | null>> = {};

/**
 * Build a default layout from a list of enabled metric-card ids (e.g. the host's
 * current the `enabledWidgets` host setting), preserving canonical order. Manager
 * cards are not added by default.
 */
export function defaultLayoutFromWidgets(
  enabledWidgets: string[],
  columns = 3,
): HostMetricsLayout {
  const enabled = new Set(enabledWidgets);
  const ids = METRIC_CARD_IDS.filter((id) => enabled.has(id));
  const slots: HostMetricsSlot[] = ids.map((id, i) => ({
    id,
    order: i,
    colSpan: DEFAULT_COLSPAN[id] ?? 1,
    height: DEFAULT_HEIGHT[id] ?? null,
  }));
  return { slots, columns };
}

export function defaultColSpanFor(id: HostMetricsCardId): HostMetricsColSpan {
  return DEFAULT_COLSPAN[id] ?? (isManagerCardId(id) ? 2 : 1);
}

export function defaultHeightFor(id: HostMetricsCardId): number | null {
  if (id in DEFAULT_HEIGHT) return DEFAULT_HEIGHT[id] ?? null;
  return null;
}

export interface HostMetricsCardSettings {
  chartSize?: "compact" | "regular" | "large";
  showHardware?: boolean;
  showSystemCounts?: boolean;
  showComposition?: boolean;
  showActivity?: boolean;
  showAddresses?: boolean;
  showLink?: boolean;
  showCores?: boolean;
  showCoreGraphs?: boolean;
  showLoopback?: boolean;
  showLoad?: boolean;
  showBreakdown?: boolean;
  showDetails?: boolean;
  showProcesses?: boolean;
  showSensors?: boolean;
  showFailedLogins?: boolean;
}

// Only presentation controls supported by each card are persisted.
export const CARD_SETTINGS: Partial<
  Record<HostMetricsCardId, (keyof HostMetricsCardSettings)[]>
> = {
  cpu: [
    "chartSize",
    "showCores",
    "showCoreGraphs",
    "showLoad",
    "showBreakdown",
    "showHardware",
    "showSystemCounts",
  ],
  memory: [
    "chartSize",
    "showDetails",
    "showBreakdown",
    "showComposition",
    "showHardware",
  ],
  disk: ["chartSize", "showDetails", "showActivity", "showHardware"],
  network: [
    "chartSize",
    "showDetails",
    "showActivity",
    "showAddresses",
    "showLink",
    "showLoopback",
  ],
  gpu: ["chartSize", "showDetails", "showProcesses"],
  temperature: ["showSensors"],
  system: ["showDetails"],
  uptime: ["showDetails"],
  login_stats: ["showFailedLogins"],
  processes: ["showDetails"],
  ports: ["showDetails"],
  firewall: ["showDetails"],
};

export function sanitizeCardSettings(
  id: string,
  input: unknown,
): HostMetricsCardSettings | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return undefined;
  const values = input as Record<string, unknown>;
  const result: HostMetricsCardSettings = {};
  for (const key of Object.hasOwn(CARD_SETTINGS, id)
    ? CARD_SETTINGS[id as HostMetricsCardId]!
    : []) {
    const value = values[key];
    if (key === "chartSize") {
      if (value === "compact" || value === "regular" || value === "large")
        result.chartSize = value;
    } else if (typeof value === "boolean") result[key] = value;
  }
  return Object.keys(result).length ? result : undefined;
}

export function sanitizeLayout(input: unknown): HostMetricsLayout | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.slots)) return null;
  const columns =
    typeof obj.columns === "number" && obj.columns >= 1 && obj.columns <= 4
      ? Math.round(obj.columns)
      : 3;
  const seen = new Set<string>();
  const slots = obj.slots
    .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
    .filter((s) => {
      if (typeof s.id !== "string" || !s.id || seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    })
    .map((s, i) => {
      const settings = sanitizeCardSettings(s.id as string, s.settings);
      return {
        id: s.id as HostMetricsCardId,
        order:
          typeof s.order === "number" && Number.isFinite(s.order) ? s.order : i,
        colSpan: s.colSpan === 2 || s.colSpan === 3 ? s.colSpan : 1,
        height:
          typeof s.height === "number" &&
          Number.isFinite(s.height) &&
          s.height > 0
            ? Math.min(10000, Math.max(80, Math.round(s.height)))
            : null,
        ...(typeof s.width === "number" && Number.isFinite(s.width)
          ? {
              width: Math.min(
                MAX_CARD_WIDTH,
                Math.max(MIN_CARD_WIDTH, Math.round(s.width)),
              ),
            }
          : {}),
        ...gridPosition(s),
        ...(settings ? { settings } : {}),
      };
    });
  return { slots, columns } as HostMetricsLayout;
}

function gridPosition(s: Record<string, unknown>) {
  const { x, y, w } = s;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    ![x, y, w].every(Number.isFinite)
  )
    return {};
  const width = Math.min(
    GRID_COLUMNS,
    Math.max(MIN_CARD_COLUMNS, Math.round(w)),
  );
  return {
    x: Math.min(GRID_COLUMNS - width, Math.max(0, Math.round(x))),
    y: Math.min(1_000_000, Math.max(0, Math.round(y))),
    w: width,
  };
}
