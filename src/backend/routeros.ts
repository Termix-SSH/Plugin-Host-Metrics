import { execCommand } from "@termix-ssh/plugin-sdk/host-commands";
import type { Client } from "ssh2";
import type { CollectedMetrics } from "./collect.js";
import type { MetricsState } from "./state.js";
import {
  counterRate,
  type NetworkCounters,
} from "./widgets/network-collector.js";
import { toFixedNum } from "./util.js";

/**
 * MikroTik RouterOS v7. Its shell is not POSIX, so none of the bash
 * collectors work; these scripts print key=value pairs the parsers read.
 */
export const ROUTEROS_RESOURCE = ":put [/system resource get]";
export const ROUTEROS_IDENTITY = ":put [/system identity get name]";
export const ROUTEROS_HEALTH =
  ':foreach i in=[/system health find] do={:put ([/system health get $i name].";".[/system health get $i value].";".[/system health get $i type])}';
export const ROUTEROS_INTERFACES =
  ':foreach i in=[/interface find] do={:put ([/interface get $i name].";".[/interface get $i rx-byte].";".[/interface get $i tx-byte].";".[/interface get $i running].";".[/interface get $i disabled])}';
export const ROUTEROS_ADDRESSES =
  ':foreach i in=[/ip address find] do={:put ([/ip address get $i interface].";".[/ip address get $i address])}';

/** Hosts found to run RouterOS, so later samples skip the detection. */
const knownRouterOs = new Set<number>();

/** Whether the host answers like RouterOS. Only asked when uname failed. */
export async function isRouterOs(
  client: Client,
  hostId: number,
): Promise<boolean> {
  if (knownRouterOs.has(hostId)) return true;
  try {
    const { stdout } = await execCommand(
      client,
      ":put [/system resource get version]",
      10000,
    );
    if (/^\d+\.\d+/.test(stdout.trim())) {
      knownRouterOs.add(hostId);
      return true;
    }
  } catch {
    // not RouterOS
  }
  return false;
}

export function isKnownRouterOs(hostId: number): boolean {
  return knownRouterOs.has(hostId);
}

/** `:put` of an array: key=value pairs split by ";". */
export function parseRouterOsArray(output: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of output.trim().split(";")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
}

/** "1w2d03:04:05", "2d03:04:05", "03:04:05" or "1w2d3h4m5s" to seconds. */
export function parseRouterOsUptime(value: string | undefined): number | null {
  if (!value) return null;
  const units: Record<string, number> = {
    w: 604800,
    d: 86400,
    h: 3600,
    m: 60,
    s: 1,
  };
  let rest = value.trim();
  let seconds = 0;
  const clock = /(\d+):(\d{2}):(\d{2})$/.exec(rest);
  if (clock) {
    seconds += Number(clock[1]) * 3600 + Number(clock[2]) * 60;
    seconds += Number(clock[3]);
    rest = rest.slice(0, clock.index);
  }
  const parts = rest.match(/\d+[wdhms]/g) ?? [];
  if (!clock && parts.length === 0) return null;
  for (const part of parts) {
    seconds += Number(part.slice(0, -1)) * units[part.slice(-1)];
  }
  return seconds;
}

function formatUptime(seconds: number | null): string | null {
  if (seconds === null) return null;
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${days}d ${hours}h ${minutes}m`;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function humanize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)}${units[unit]}`;
}

export interface RouterOsHealthSensor {
  name: string;
  value: number;
  type: string;
}

export function parseRouterOsHealth(output: string): RouterOsHealthSensor[] {
  return output
    .split("\n")
    .map((line) => line.trim().split(";"))
    .filter((parts) => parts.length >= 3 && parts[0])
    .map(([name, value, type]) => ({ name, value: Number(value), type }))
    .filter((sensor) => Number.isFinite(sensor.value));
}

export interface RouterOsInterface {
  name: string;
  rx: string;
  tx: string;
  running: boolean;
  disabled: boolean;
}

export function parseRouterOsInterfaces(output: string): RouterOsInterface[] {
  return output
    .split("\n")
    .map((line) => line.trim().split(";"))
    .filter((parts) => parts.length >= 5 && parts[0])
    .map(([name, rx, tx, running, disabled]) => ({
      name,
      rx,
      tx,
      running: running === "true",
      disabled: disabled === "true",
    }));
}

/** Interface name to its first address, without the prefix length. */
export function parseRouterOsAddresses(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    const [iface, address] = line.trim().split(";");
    if (iface && address && !map.has(iface)) {
      map.set(iface, address.split("/")[0]);
    }
  }
  return map;
}

async function run(client: Client, command: string): Promise<string> {
  try {
    return (await execCommand(client, command, 15000)).stdout;
  } catch {
    return "";
  }
}

/** The values a RouterOS device gives, in the shape the cards read. */
export function buildRouterOsMetrics(
  input: {
    resource: string;
    identity: string;
    health: string;
    interfaces: string;
    addresses: string;
  },
  previous:
    { counters: Map<string, NetworkCounters>; timestamp: number } | undefined,
  now: number,
): {
  metrics: CollectedMetrics;
  counters: Map<string, NetworkCounters>;
} {
  const res = parseRouterOsArray(input.resource);
  const cpuLoad = num(res["cpu-load"]);
  const cores = num(res["cpu-count"]);
  const freeMem = num(res["free-memory"]);
  const totalMem = num(res["total-memory"]);
  const freeHdd = num(res["free-hdd-space"]);
  const totalHdd = num(res["total-hdd-space"]);
  const usedMem =
    freeMem !== null && totalMem !== null ? totalMem - freeMem : null;
  const usedHdd =
    freeHdd !== null && totalHdd !== null ? totalHdd - freeHdd : null;
  const gib = (bytes: number | null) =>
    bytes === null ? null : toFixedNum(bytes / 1024 ** 3, 2);
  const percentOf = (used: number | null, total: number | null) =>
    used !== null && total ? toFixedNum((used / total) * 100, 0) : null;

  const uptimeSeconds = parseRouterOsUptime(res.uptime);
  const sensors = parseRouterOsHealth(input.health).filter(
    (sensor) => sensor.type === "C" || /temperature/i.test(sensor.name),
  );
  const highest = sensors.reduce<number | null>(
    (max, sensor) =>
      max === null ? sensor.value : Math.max(max, sensor.value),
    null,
  );

  const addresses = parseRouterOsAddresses(input.addresses);
  const elapsed = previous ? (now - previous.timestamp) / 1000 : 0;
  const counters = new Map<string, NetworkCounters>();
  const interfaces = parseRouterOsInterfaces(input.interfaces)
    .filter((iface) => !iface.disabled)
    .map((iface) => {
      counters.set(iface.name, { rx: iface.rx, tx: iface.tx });
      const before = previous?.counters.get(iface.name);
      return {
        name: iface.name,
        ip: addresses.get(iface.name) ?? "",
        state: iface.running ? "UP" : "DOWN",
        rxBytes: iface.rx || null,
        txBytes: iface.tx || null,
        rxRateBps: before ? counterRate(before.rx, iface.rx, elapsed) : null,
        txRateBps: before ? counterRate(before.tx, iface.tx, elapsed) : null,
      };
    });

  const diskPercent = percentOf(usedHdd, totalHdd);
  const filesystem = {
    filesystem: "flash",
    type: "routeros",
    mount: "/",
    percent: diskPercent,
    usedHuman: usedHdd !== null ? humanize(usedHdd) : null,
    totalHuman: totalHdd !== null ? humanize(totalHdd) : null,
    availableHuman: freeHdd !== null ? humanize(freeHdd) : null,
    usedBytes: usedHdd,
    totalBytes: totalHdd,
    availableBytes: freeHdd,
  };

  const board = res["board-name"];
  const version = res.version;
  const metrics = {
    cpu: { percent: cpuLoad, cores, load: null },
    memory: {
      percent: percentOf(usedMem, totalMem),
      usedGiB: gib(usedMem),
      totalGiB: gib(totalMem),
    },
    disk: {
      percent: diskPercent,
      usedHuman: filesystem.usedHuman,
      totalHuman: filesystem.totalHuman,
      availableHuman: filesystem.availableHuman,
      mount: "/",
      filesystems: totalHdd !== null ? [filesystem] : [],
    },
    network: { interfaces },
    uptime: { seconds: uptimeSeconds, formatted: formatUptime(uptimeSeconds) },
    processes: { total: null, running: null, top: [] },
    system: {
      hostname: input.identity.trim() || null,
      kernel: version ? `RouterOS ${version}` : null,
      os: board ? `MikroTik ${board}` : "MikroTik RouterOS",
    },
    login_stats: {
      recentLogins: [],
      failedLogins: [],
      totalLogins: 0,
      uniqueIPs: 0,
    },
    ports: { source: "none", ports: [] },
    firewall: { type: "none", status: "unknown", chains: [] },
    temperature: {
      source: sensors.length > 0 ? "sensors" : "none",
      highestCelsius: highest,
      sensors: sensors.map((sensor) => ({
        label: sensor.name,
        celsius: sensor.value,
      })),
    },
    gpu: { source: "none", gpus: [], processes: [] },
  } as unknown as CollectedMetrics;

  return { metrics, counters };
}

/** One RouterOS sample. */
export async function collectRouterOsMetrics(
  client: Client,
  hostId: number,
  state: Pick<MetricsState, "rateSamples">,
): Promise<CollectedMetrics> {
  const resource = await run(client, ROUTEROS_RESOURCE);
  const identity = await run(client, ROUTEROS_IDENTITY);
  const health = await run(client, ROUTEROS_HEALTH);
  const interfaces = await run(client, ROUTEROS_INTERFACES);
  const addresses = await run(client, ROUTEROS_ADDRESSES);
  const samples = state.rateSamples.network.counters;
  const now = Date.now();
  const { metrics, counters } = buildRouterOsMetrics(
    { resource, identity, health, interfaces, addresses },
    samples.get(hostId),
    now,
  );
  samples.set(hostId, { counters, timestamp: now });
  return metrics;
}
