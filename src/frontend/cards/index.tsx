import { type ServerMetrics } from "../../shared/metrics.js";
import {
  defaultColSpanFor,
  defaultHeightFor,
  type HostMetricsCardId,
} from "../../shared/host-metrics.js";
import type { ComponentType, ReactNode } from "react";
import { CpuCard } from "./CpuCard";
import { MemoryCard } from "./MemoryCard";
import { SwapCard } from "./SwapCard";
import { DiskCard } from "./DiskCard";
import { NetworkCard } from "./NetworkCard";
import { UptimeCard } from "./UptimeCard";
import { SystemCard } from "./SystemCard";
import { LoginStatsCard } from "./LoginStatsCard";
import { PortsCard } from "./PortsCard";
import { ProcessesCard } from "./ProcessesCard";
import { FirewallCard } from "./FirewallCard";
import { TemperatureCard } from "./TemperatureCard";
import { GpuCard } from "./GpuCard";
import type { GpuHistories } from "./gpu-history";
import { HealthCheckCard } from "./managers/HealthCheckCard";
import {
  TopMemoryCard,
  DiskBreakdownCard,
} from "./managers/SimpleManagerCards";

export interface MetricCardHistories {
  /** When each cpu, memory and disk point was taken, ISO time. */
  ts: string[];
  cpu: Array<number | null>;
  memory: Array<number | null>;
  swap?: Array<number | null>;
  disk: Array<number | null>;
  gpu: GpuHistories;
}

interface CardRenderContext {
  metrics: ServerMetrics | null;
  histories: MetricCardHistories;
  hostId: number | null;
}

export interface CardDefinition {
  id: HostMetricsCardId;
  /** i18n key for the card's display label. */
  labelKey: string;
  kind: "metric" | "manager";
  render: (ctx: CardRenderContext) => ReactNode;
}

type SimpleMetricCard = ComponentType<{
  metrics: ServerMetrics | null;
  hostId: number | null;
}>;
type HistoryMetricCard = ComponentType<{
  metrics: ServerMetrics | null;
  history: Array<number | null>;
  timestamps?: string[];
  hostId: number | null;
}>;

function metricCard(
  id: HostMetricsCardId,
  labelKey: string,
  Comp: SimpleMetricCard,
): CardDefinition {
  return {
    id,
    labelKey,
    kind: "metric",
    render: ({ metrics, hostId }) => <Comp metrics={metrics} hostId={hostId} />,
  };
}

function historyCard(
  id: HostMetricsCardId,
  labelKey: string,
  Comp: HistoryMetricCard,
  series: "cpu" | "memory" | "swap" | "disk",
): CardDefinition {
  return {
    id,
    labelKey,
    kind: "metric",
    render: ({ metrics, histories, hostId }) => (
      <Comp
        metrics={metrics}
        history={histories[series] ?? []}
        timestamps={histories.ts}
        hostId={hostId}
      />
    ),
  };
}

type ManagerCardComp = ComponentType<{ hostId: number | null }>;

function managerCard(
  id: HostMetricsCardId,
  labelKey: string,
  Comp: ManagerCardComp,
): CardDefinition {
  return {
    id,
    labelKey,
    kind: "manager",
    render: ({ hostId }) => <Comp hostId={hostId} />,
  };
}

export const CARD_DEFINITIONS: Record<string, CardDefinition> = {
  cpu: historyCard("cpu", "hostMetrics.cpuUsage", CpuCard, "cpu"),
  memory: historyCard(
    "memory",
    "hostMetrics.memoryUsage",
    MemoryCard,
    "memory",
  ),
  disk: historyCard("disk", "hostMetrics.diskUsage", DiskCard, "disk"),
  swap: historyCard("swap", "hostMetrics.swapUsage", SwapCard, "swap"),
  network: metricCard("network", "hostMetrics.networkInterfaces", NetworkCard),
  uptime: metricCard("uptime", "hostMetrics.uptime", UptimeCard),
  system: metricCard("system", "hostMetrics.systemInfo", SystemCard),
  login_stats: metricCard(
    "login_stats",
    "hostMetrics.loginStats",
    LoginStatsCard,
  ),
  ports: metricCard("ports", "hostMetrics.ports.title", PortsCard),
  processes: metricCard("processes", "hostMetrics.processes", ProcessesCard),
  firewall: metricCard("firewall", "hostMetrics.firewall.title", FirewallCard),
  temperature: metricCard(
    "temperature",
    "hostMetrics.temperature",
    TemperatureCard,
  ),
  gpu: {
    id: "gpu",
    labelKey: "hostMetrics.gpu.title",
    kind: "metric",
    render: ({ metrics, histories }) => (
      <GpuCard metrics={metrics} gpuHistories={histories.gpu} />
    ),
  },
  health_check: managerCard(
    "health_check",
    "hostMetrics.managers.healthCheck",
    HealthCheckCard,
  ),
  disk_breakdown: managerCard(
    "disk_breakdown",
    "hostMetrics.managers.diskBreakdown",
    DiskBreakdownCard,
  ),
  top_memory: managerCard(
    "top_memory",
    "hostMetrics.managers.topMemory",
    TopMemoryCard,
  ),
};

/**
 * Manager cards other plugins contribute to "host-metrics.managers" (a
 * component slot), keyed by contribution actionId. Built once per render from
 * useSlotContributions and merged with CARD_DEFINITIONS below, so a plugin
 * like tailscale can add its own manager card without host-metrics knowing it
 * exists.
 */
export function definitionsFromSlot(
  contributions: Array<{
    actionId: string;
    titleKey: string;
    component?: ComponentType<Record<string, unknown>>;
  }>,
): Record<string, CardDefinition> {
  const out: Record<string, CardDefinition> = {};
  for (const contribution of contributions) {
    if (!contribution.component) continue;
    const Comp = contribution.component;
    out[contribution.actionId] = {
      id: contribution.actionId as HostMetricsCardId,
      labelKey: contribution.titleKey,
      kind: "manager",
      render: ({ hostId }) => <Comp hostId={hostId} />,
    };
  }
  return out;
}

/** All card ids built into this plugin and available in the Add tray. */
export const IMPLEMENTED_CARD_IDS = Object.keys(
  CARD_DEFINITIONS,
) as HostMetricsCardId[];

export function getCardDefinition(
  id: string,
  extra?: Record<string, CardDefinition>,
): CardDefinition | undefined {
  return CARD_DEFINITIONS[id] ?? extra?.[id];
}

export { defaultColSpanFor, defaultHeightFor };
