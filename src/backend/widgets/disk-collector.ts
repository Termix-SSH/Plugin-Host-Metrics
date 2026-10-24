import {
  execCommand,
  execPowerShell,
  type HostPlatform,
} from "@termix-ssh/plugin-sdk/host-commands";
import {
  buildFilesystemList,
  filterExcludedFilesystems,
  mergeMonitoredFilesystems,
  parseDfLines,
  selectPrimaryFilesystem,
  shellQuote,
  type DiskFilesystem,
  type MonitoredMount,
} from "@termix-ssh/plugin-sdk/host-scripts";
import { toFixedNum } from "../util.js";
import type { Client } from "ssh2";

export {
  buildFilesystemList,
  filterExcludedFilesystems,
  findWorstMountIndex,
  mergeMonitoredFilesystems,
  parseDfLines,
  selectPrimaryFilesystem,
} from "@termix-ssh/plugin-sdk/host-scripts";
export type {
  DfRow,
  DiskFilesystem,
  MonitoredMount,
} from "@termix-ssh/plugin-sdk/host-scripts";

function humanizeBytes(bytes: number): string {
  const units = ["B", "K", "M", "G", "T", "P"];
  let value = Math.max(0, bytes);
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const rounded =
    unitIndex > 0 && value < 10 ? value.toFixed(1) : Math.round(value);
  return `${rounded}${units[unitIndex]}`;
}

// BSD/macOS `df -T` takes a filesystem-type argument to *filter* by, unlike
// GNU `df -T` which *prints* a type column - so macOS needs its own command
// (`df -Pk`, no type column) and gets the type separately from `mount`.
const DARWIN_SKIP_MOUNT_RE =
  /^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware)(\/|$)/;
const DARWIN_SKIP_TYPE_RE = /^(devfs|autofs)$/;

export function parseDarwinMountTypes(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split("\n")) {
    // Device names can contain spaces (e.g. autofs's "map auto_home"), so
    // match the literal " on " / " (" separators rather than a single token.
    const match = line.match(/^.+? on (.+?) \(([^,)]+)/);
    if (match) map.set(match[1], match[2].trim());
  }
  return map;
}

export function parseDarwinDfRows(
  output: string,
  typeByMount: Map<string, string>,
): DiskFilesystem[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s+/);
      if (parts.length < 6) return null;

      const filesystem = parts[0];
      const totalKb = Number(parts[1]);
      const usedKb = Number(parts[2]);
      const availableKb = Number(parts[3]);
      const mount = parts.slice(5).join(" ");
      if (!Number.isFinite(totalKb) || totalKb <= 0) return null;
      if (DARWIN_SKIP_MOUNT_RE.test(mount)) return null;

      const type = typeByMount.get(mount) || "";
      if (DARWIN_SKIP_TYPE_RE.test(type)) return null;

      const totalBytes = totalKb * 1024;
      const usedBytes = Number.isFinite(usedKb) ? usedKb * 1024 : null;
      const availableBytes = Number.isFinite(availableKb)
        ? availableKb * 1024
        : null;
      // APFS volumes all report the whole container as their size, so use
      // used / (used + available) like df's Capacity column.
      const capacity =
        usedBytes !== null && availableBytes !== null
          ? usedBytes + availableBytes
          : totalBytes;
      const percent =
        usedBytes !== null && capacity > 0
          ? Math.max(0, Math.min(100, (usedBytes / capacity) * 100))
          : null;

      return {
        filesystem,
        type,
        mount,
        percent: toFixedNum(percent, 0),
        usedHuman: usedBytes !== null ? humanizeBytes(usedBytes) : null,
        totalHuman: humanizeBytes(totalBytes),
        availableHuman:
          availableBytes !== null ? humanizeBytes(availableBytes) : null,
        usedBytes,
        totalBytes,
        availableBytes,
      };
    })
    .filter((fs): fs is DiskFilesystem => fs !== null);
}

async function collectDarwinDiskMetrics(
  client: Client,
  excludedMounts?: string[] | null,
  monitoredMounts?: MonitoredMount[] | null,
): Promise<{
  percent: number | null;
  usedHuman: string | null;
  totalHuman: string | null;
  availableHuman: string | null;
  mount: string | null;
  filesystems: DiskFilesystem[];
}> {
  try {
    const [dfOut, mountOut] = await Promise.all([
      execCommand(client, "df -Pk | tail -n +2"),
      execCommand(client, "mount"),
    ]);

    const typeByMount = parseDarwinMountTypes(mountOut.stdout);
    let detected = parseDarwinDfRows(dfOut.stdout, typeByMount);

    const monitored = (monitoredMounts ?? []).filter((entry) =>
      Boolean(entry.path.trim()),
    );
    if (monitored.length > 0) {
      const customFilesystems = await Promise.all(
        monitored.map(async (entry) => {
          const path = shellQuote(entry.path.trim());
          try {
            const custom = await execCommand(
              client,
              `df -Pk -- ${path} | tail -n +2`,
            );
            return parseDarwinDfRows(custom.stdout, typeByMount)[0] ?? null;
          } catch {
            return null;
          }
        }),
      );
      detected = mergeMonitoredFilesystems(
        detected,
        monitored,
        customFilesystems,
      );
    }

    const filesystems = filterExcludedFilesystems(detected, excludedMounts);
    const primary = selectPrimaryFilesystem(filesystems);

    return {
      percent: primary?.percent ?? null,
      usedHuman: primary?.usedHuman ?? null,
      totalHuman: primary?.totalHuman ?? null,
      availableHuman: primary?.availableHuman ?? null,
      mount: primary?.mount ?? null,
      filesystems,
    };
  } catch {
    return {
      percent: null,
      usedHuman: null,
      totalHuman: null,
      availableHuman: null,
      mount: null,
      filesystems: [],
    };
  }
}

interface WindowsDiskRow {
  drive: string;
  total: number;
  free: number;
}

const WINDOWS_DISK_SCRIPT =
  'Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {' +
  " [PSCustomObject]@{drive=$_.DeviceID; total=$_.Size; free=$_.FreeSpace}" +
  " } | ConvertTo-Json -Compress";

export function parseWindowsDiskJson(output: string): WindowsDiskRow[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((row): row is Record<string, unknown> => Boolean(row?.drive))
      .map((row) => ({
        drive: String(row.drive),
        total: Number(row.total),
        free: Number(row.free),
      }))
      .filter((row) => Number.isFinite(row.total) && row.total > 0);
  } catch {
    return [];
  }
}

async function collectWindowsDiskMetrics(
  client: Client,
  excludedMounts?: string[] | null,
): Promise<{
  percent: number | null;
  usedHuman: string | null;
  totalHuman: string | null;
  availableHuman: string | null;
  mount: string | null;
  filesystems: DiskFilesystem[];
}> {
  try {
    const { stdout } = await execPowerShell(client, WINDOWS_DISK_SCRIPT);
    const rows = parseWindowsDiskJson(stdout);

    const filesystems: DiskFilesystem[] = rows.map((row) => {
      const usedBytes = row.total - row.free;
      const percent = Math.max(0, Math.min(100, (usedBytes / row.total) * 100));
      return {
        filesystem: row.drive,
        type: "NTFS",
        mount: row.drive,
        percent: toFixedNum(percent, 0),
        usedHuman: humanizeBytes(usedBytes),
        totalHuman: humanizeBytes(row.total),
        availableHuman: humanizeBytes(row.free),
        usedBytes,
        totalBytes: row.total,
        availableBytes: row.free,
      };
    });

    const filtered = filterExcludedFilesystems(filesystems, excludedMounts);
    const primary =
      filtered.find((fs) => fs.mount.toUpperCase().startsWith("C")) ??
      filtered[0] ??
      null;

    return {
      percent: primary?.percent ?? null,
      usedHuman: primary?.usedHuman ?? null,
      totalHuman: primary?.totalHuman ?? null,
      availableHuman: primary?.availableHuman ?? null,
      mount: primary?.mount ?? null,
      filesystems: filtered,
    };
  } catch {
    return {
      percent: null,
      usedHuman: null,
      totalHuman: null,
      availableHuman: null,
      mount: null,
      filesystems: [],
    };
  }
}

export async function collectDiskMetrics(
  client: Client,
  excludedMounts?: string[] | null,
  monitoredMounts?: MonitoredMount[] | null,
  platform?: HostPlatform,
): Promise<{
  percent: number | null;
  usedHuman: string | null;
  totalHuman: string | null;
  availableHuman: string | null;
  mount: string | null;
  filesystems: DiskFilesystem[];
}> {
  if (platform === "windows") {
    return collectWindowsDiskMetrics(client, excludedMounts);
  }
  if (platform === "darwin") {
    return collectDarwinDiskMetrics(client, excludedMounts, monitoredMounts);
  }

  try {
    const [diskOutHuman, diskOutBytes] = await Promise.all([
      execCommand(client, "df -hT -P | tail -n +2"),
      execCommand(client, "df -TkP | tail -n +2"),
    ]);

    const humanRows = parseDfLines(diskOutHuman.stdout);
    const bytesRows = parseDfLines(diskOutBytes.stdout);
    let detected = buildFilesystemList(bytesRows, humanRows, 1024);
    const monitored = (monitoredMounts ?? []).filter((entry) =>
      Boolean(entry.path.trim()),
    );
    if (monitored.length > 0) {
      const customFilesystems = await Promise.all(
        monitored.map(async (entry) => {
          const path = shellQuote(entry.path.trim());
          try {
            const [customHuman, customBytes] = await Promise.all([
              execCommand(client, `df -hT -P -- ${path} | tail -n +2`),
              execCommand(client, `df -TkP -- ${path} | tail -n +2`),
            ]);
            return (
              buildFilesystemList(
                parseDfLines(customBytes.stdout),
                parseDfLines(customHuman.stdout),
                1024,
              )[0] ?? null
            );
          } catch {
            return null;
          }
        }),
      );
      detected = mergeMonitoredFilesystems(
        detected,
        monitored,
        customFilesystems,
      );
    }
    const filesystems = filterExcludedFilesystems(detected, excludedMounts);
    const primary = selectPrimaryFilesystem(filesystems);

    return {
      percent: primary?.percent ?? null,
      usedHuman: primary?.usedHuman ?? null,
      totalHuman: primary?.totalHuman ?? null,
      availableHuman: primary?.availableHuman ?? null,
      mount: primary?.mount ?? null,
      filesystems,
    };
  } catch {
    return {
      percent: null,
      usedHuman: null,
      totalHuman: null,
      availableHuman: null,
      mount: null,
      filesystems: [],
    };
  }
}
