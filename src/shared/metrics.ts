import type { GpuMetrics, FirewallMetrics } from "./stats-widgets.js";

/** What GET /metrics/:id answers. */
interface CpuMetrics {
  details?: CpuDetails;
  percent: number | null;
  cores: number | null;
  load: [number, number, number] | null;
  /** Per-core percent, from the 1s live sample. */
  perCore?: Array<number | null>;
  /** Kernel CPU numbers for perCore, which skip offline cores. */
  coreIds?: string[];
  /** Percent of CPU time by kind since the last live sample. */
  mix?: { user: number; system: number; iowait: number; steal: number };
}

interface MemoryMetrics {
  details?: MemoryDetails;
  percent: number | null;
  usedGiB: number | null;
  totalGiB: number | null;
  /** Buffers plus page cache, from the live sample. */
  cachedGiB?: number;
  /** Completely unused memory, from the live sample. */
  freeGiB?: number;
}

export interface DiskFilesystem {
  filesystem: string;
  type: string;
  mount: string;
  percent: number | null;
  usedHuman: string | null;
  totalHuman: string | null;
  availableHuman: string | null;
  usedBytes: number | null;
  totalBytes: number | null;
  availableBytes: number | null;
  label?: string;
}

interface DiskMetrics {
  devices?: PhysicalDisk[];
  percent: number | null;
  usedHuman: string | null;
  totalHuman: string | null;
  availableHuman?: string | null;
  mount?: string | null;
  filesystems?: DiskFilesystem[];
}

interface NetworkInterface {
  details?: AdapterDetails;
  name: string;
  ip: string;
  state: string;
  rx?: string | null;
  tx?: string | null;
  rxBytes?: string | null;
  txBytes?: string | null;
  rxRateBps?: number | null;
  txRateBps?: number | null;
}

/** Read-only OS counters. null means unsupported, denied, or not yet sampled. */
export interface CpuDetails {
  model: string | null;
  currentGHz: number | null;
  baseGHz: number | null;
  maxGHz: number | null;
  sockets: number | null;
  physicalCores: number | null;
  logicalCores: number | null;
  virtualization: string | null;
  l1Bytes: number | null;
  l2Bytes: number | null;
  l3Bytes: number | null;
  processes: number | null;
  threads: number | null;
  handles: number | null;
  uptimeSeconds: number | null;
  semantics: "linux" | "darwin" | "windows";
}

export interface MemoryDetails {
  availableBytes: number | null;
  compressedBytes: number | null;
  committedBytes: number | null;
  commitLimitBytes: number | null;
  cachedBytes: number | null;
  pagedPoolBytes: number | null;
  nonpagedPoolBytes: number | null;
  reclaimableSlabBytes: number | null;
  unreclaimableSlabBytes: number | null;
  wiredBytes: number | null;
  installedBytes: number | null;
  hardwareReservedBytes: number | null;
  speedMHz: number | null;
  slotsUsed: number | null;
  slotsTotal: number | null;
  memoryType: string | null;
  formFactor: string | null;
  semantics: "linux" | "darwin" | "windows";
}

export interface PhysicalDisk {
  id: string;
  model: string | null;
  media: string | null;
  bus: string | null;
  capacityBytes: number | null;
  formattedBytes: number | null;
  system: boolean | null;
  pagefile: boolean | null;
  activePercent: number | null;
  readBps: number | null;
  writeBps: number | null;
  latencyMs: number | null;
}

export interface AdapterDetails {
  model: string | null;
  type: string | null;
  ipv4: string[] | null;
  ipv6: string[] | null;
  dns: string[] | null;
  linkMbps: number | null;
  mac: string | null;
  duplex: string | null;
}

interface ProcessInfo {
  pid: string;
  user: string;
  cpu: string;
  mem: string;
  command: string;
  state?: string;
  ppid?: string;
}

interface LoginRecord {
  user: string;
  ip: string;
  time: string;
  status: "success" | "failed";
}

export interface ListeningPort {
  protocol: "tcp" | "udp";
  localAddress: string;
  localPort: number;
  state?: string;
  pid?: number;
  process?: string;
}

export type { FirewallChain } from "./stats-widgets.js";

/** One 1s /proc sample from GET /host-metrics/managers/live/:id. */
export type { LiveSample } from "@termix-ssh/plugin-sdk/host-scripts";

export type ServerMetrics = {
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disk: DiskMetrics;
  network?: { interfaces?: NetworkInterface[] };
  uptime?: { seconds?: number | null; formatted?: string | null };
  system?: {
    hostname?: string | null;
    os?: string | null;
    kernel?: string | null;
    arch?: string | null;
  };
  processes?: {
    total?: number | null;
    running?: number | null;
    top?: ProcessInfo[];
  };
  login_stats?: {
    recentLogins?: LoginRecord[];
    failedLogins?: LoginRecord[];
    totalLogins?: number;
    uniqueIPs?: number;
  };
  ports?: {
    source?: "ss" | "netstat" | "none";
    ports?: ListeningPort[];
  };
  firewall?: Partial<FirewallMetrics>;
  temperature?: {
    source?: "sysfs" | "sensors" | "none";
    highestCelsius?: number | null;
    sensors?: Array<{
      label: string;
      celsius: number;
    }>;
  };
  gpu?: GpuMetrics;
  lastChecked: string;
};
