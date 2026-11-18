import {
  execCommand,
  execPowerShell,
  type HostPlatform,
} from "@termix-ssh/plugin-sdk/host-commands";
import { toFixedNum, kibToGiB } from "../util.js";
import { ARC_SCRIPT, splitArc } from "./zfs-arc.js";
import type { Client } from "ssh2";

async function collectDarwinMemoryMetrics(client: Client): Promise<{
  percent: number | null;
  usedGiB: number | null;
  totalGiB: number | null;
}> {
  let memPercent: number | null = null;
  let usedGiB: number | null = null;
  let totalGiB: number | null = null;

  try {
    const [vmStatOut, memSizeOut] = await Promise.all([
      execCommand(client, "vm_stat"),
      execCommand(client, "sysctl -n hw.memsize"),
    ]);

    const totalBytes = Number((memSizeOut.stdout || "").trim());
    const pageSizeMatch = vmStatOut.stdout.match(/page size of (\d+) bytes/);
    const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;

    const getPages = (key: string): number | null => {
      const line = vmStatOut.stdout
        .split("\n")
        .find((l) => l.trim().startsWith(key));
      if (!line) return null;
      const m = line.match(/(\d+)\./);
      return m ? Number(m[1]) : null;
    };

    const active = getPages("Pages active");
    const wired = getPages("Pages wired down");
    const compressed = getPages("Pages occupied by compressor");

    if (
      Number.isFinite(totalBytes) &&
      totalBytes > 0 &&
      active !== null &&
      wired !== null
    ) {
      const usedPages = active + wired + (compressed ?? 0);
      const usedBytes = usedPages * pageSize;
      memPercent = Math.max(0, Math.min(100, (usedBytes / totalBytes) * 100));
      usedGiB = kibToGiB(usedBytes / 1024);
      totalGiB = kibToGiB(totalBytes / 1024);
    }
  } catch {
    memPercent = null;
    usedGiB = null;
    totalGiB = null;
  }

  return {
    percent: toFixedNum(memPercent, 0),
    usedGiB: usedGiB != null ? toFixedNum(usedGiB, 2) : null,
    totalGiB: totalGiB ? toFixedNum(totalGiB, 2) : null,
  };
}

// Win32_OperatingSystem reports TotalVisibleMemorySize/FreePhysicalMemory in KB.
async function collectWindowsMemoryMetrics(client: Client): Promise<{
  percent: number | null;
  usedGiB: number | null;
  totalGiB: number | null;
}> {
  let memPercent: number | null = null;
  let usedGiB: number | null = null;
  let totalGiB: number | null = null;

  try {
    const { stdout } = await execPowerShell(
      client,
      "$os=Get-CimInstance Win32_OperatingSystem; [PSCustomObject]@{total=$os.TotalVisibleMemorySize; free=$os.FreePhysicalMemory} | ConvertTo-Json -Compress",
    );
    const parsed = JSON.parse(stdout.trim());
    const totalKb = Number(parsed?.total);
    const freeKb = Number(parsed?.free);
    if (
      parsed?.total != null &&
      parsed?.free != null &&
      String(parsed.free).trim() !== "" &&
      Number.isFinite(totalKb) &&
      Number.isFinite(freeKb) &&
      totalKb > 0 &&
      freeKb >= 0 &&
      freeKb <= totalKb
    ) {
      const usedKb = totalKb - freeKb;
      memPercent = Math.max(0, Math.min(100, (usedKb / totalKb) * 100));
      usedGiB = kibToGiB(usedKb);
      totalGiB = kibToGiB(totalKb);
    }
  } catch {
    memPercent = null;
    usedGiB = null;
    totalGiB = null;
  }

  return {
    percent: toFixedNum(memPercent, 0),
    usedGiB: usedGiB != null ? toFixedNum(usedGiB, 2) : null,
    totalGiB: totalGiB ? toFixedNum(totalGiB, 2) : null,
  };
}

export async function collectMemoryMetrics(
  client: Client,
  platform?: HostPlatform,
): Promise<{
  percent: number | null;
  usedGiB: number | null;
  totalGiB: number | null;
  /** Reclaimable ZFS ARC, left out of usedGiB. */
  arcKb?: number;
}> {
  if (platform === "darwin") {
    return collectDarwinMemoryMetrics(client);
  }
  if (platform === "windows") {
    return collectWindowsMemoryMetrics(client);
  }

  let memPercent: number | null = null;
  let usedGiB: number | null = null;
  let totalGiB: number | null = null;
  let arcKb = 0;

  try {
    const memInfo = await execCommand(
      client,
      `cat /proc/meminfo; ${ARC_SCRIPT}`,
    );
    const { rest, arcBytes } = splitArc(memInfo.stdout);
    const lines = rest.split("\n");
    const getVal = (key: string) => {
      const line = lines.find((l) => l.startsWith(key));
      if (!line) return null;
      const m = line.match(/\d+/);
      return m ? Number(m[0]) : null;
    };
    const totalKb = getVal("MemTotal:");
    const availKb = getVal("MemAvailable:");
    if (
      totalKb != null &&
      availKb != null &&
      totalKb > 0 &&
      availKb >= 0 &&
      availKb <= totalKb
    ) {
      arcKb = Math.min(Math.floor(arcBytes / 1024), totalKb - availKb);
      const usedKb = totalKb - availKb - arcKb;
      memPercent = Math.max(0, Math.min(100, (usedKb / totalKb) * 100));
      usedGiB = kibToGiB(usedKb);
      totalGiB = kibToGiB(totalKb);
    }
  } catch {
    memPercent = null;
    usedGiB = null;
    totalGiB = null;
    arcKb = 0;
  }

  return {
    percent: toFixedNum(memPercent, 0),
    usedGiB: usedGiB != null ? toFixedNum(usedGiB, 2) : null,
    totalGiB: totalGiB ? toFixedNum(totalGiB, 2) : null,
    ...(arcKb > 0 && { arcKb }),
  };
}
