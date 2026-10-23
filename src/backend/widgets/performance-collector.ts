import type { Client } from "ssh2";
import {
  execCommand,
  execPowerShell,
  type HostPlatform,
} from "@termix-ssh/plugin-sdk/host-commands";
import type {
  CpuDetails,
  MemoryDetails,
  PhysicalDisk,
  AdapterDetails,
  ServerMetrics,
} from "../../shared/metrics.js";

export type PerformanceGroup = "cpu" | "memory" | "disk" | "network";
export const HARDWARE_REFRESH_MS = 5 * 60_000;
type HardwareCache = Record<string, { at: number; rows: unknown[] }>;
export const LINUX_PERFORMANCE_SCRIPTS: Record<PerformanceGroup, string> = {
  cpu: `printf '\\n@@CPU\\n'; cat /proc/cpuinfo 2>/dev/null | sed -n '1,8192p'
printf '\\n@@LSCPU\\n'; LC_ALL=C lscpu -J -B 2>/dev/null
printf '\\n@@STAT\\n'; sed -n '1,1025p' /proc/stat 2>/dev/null
printf '\\n@@FREQ\\n'; cat /sys/devices/system/cpu/cpu0/cpufreq/base_frequency 2>/dev/null
printf '\\n@@UPTIME\\n'; cat /proc/uptime 2>/dev/null
printf '\\n@@COUNTS\\n'; ps -e -o nlwp= 2>/dev/null | awk '{p++; t+=$1} END {if(p) print p,t}'
printf '\\n@@HANDLES\\n'; cat /proc/sys/fs/file-nr 2>/dev/null`,
  memory: `printf '\\n@@MEM\\n'; cat /proc/meminfo 2>/dev/null`,
  disk: `printf '\\n@@BLOCK\\n'; LC_ALL=C lsblk -b -J -o NAME,TYPE,SIZE,MODEL,ROTA,TRAN 2>/dev/null
printf '\\n@@DISKSTATS\\n'; cat /proc/diskstats 2>/dev/null
printf '\\n@@DISKUPTIME\\n'; cat /proc/uptime 2>/dev/null`,
  network: `printf '\\n@@DNS\\n'; resolvectl dns --no-pager 2>/dev/null
printf '\\n@@ADDR\\n'; ip -j addr show 2>/dev/null
printf '\\n@@LINKS\\n'; for d in /sys/class/net/*; do [ -e "$d" ] || continue; printf '%s|' "$(basename "$d")"; for f in speed duplex type address; do v=$(cat "$d/$f" 2>/dev/null); printf '%s|' "$v"; done; printf '%s\\n' "$(basename "$(readlink -f "$d/device/driver" 2>/dev/null)")"; done`,
};

/** Exact SSH PowerShell payload; buildPerformanceScript prefixes the admin widget gate. */
export const WINDOWS_PERFORMANCE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'
if ($null -eq $groups) { $groups = @('cpu','memory','disk','network') }
if ($null -eq $hardware) { $hardware = [PSCustomObject]@{} }
function Read-Cim($name) { @(Get-CimInstance -ClassName $name -ErrorAction SilentlyContinue) }
function Read-Hardware($name, $properties) {
 $cached = $hardware.PSObject.Properties[$name]
 if ($null -ne $cached) { return @($cached.Value) }
 try {
  $rows = @(switch ($name) {
   'PhysicalDisks' { Get-PhysicalDisk -ErrorAction Stop | Select-Object DeviceId,SerialNumber,@{Name='MediaType';Expression={[string]$_.MediaType}} }
   'Disks' { Get-Disk -ErrorAction Stop | Select-Object Number,IsSystem,@{Name='BusType';Expression={[string]$_.BusType}} }
   default { Get-CimInstance -ClassName $name -ErrorAction Stop }
  })
  $rows = @($rows | Select-Object -Property $properties)
  $hardware | Add-Member -NotePropertyName $name -NotePropertyValue $rows
  return $rows
 } catch { return @() }
}
$r = @{ hardware=$hardware }
if ($groups -contains 'cpu') {
 $p = Read-Hardware 'Win32_Processor' @('Name','MaxClockSpeed','NumberOfCores','NumberOfLogicalProcessors','VirtualizationFirmwareEnabled','L2CacheSize','L3CacheSize'); $s = Read-Cim 'Win32_PerfFormattedData_PerfOS_System' | Select-Object -First 1
 $lp = @(Read-Cim 'Win32_PerfFormattedData_Counters_ProcessorInformation' | Where-Object { $_.Name -match '^\d+,\d+$' } | Sort-Object Name)
 $handle = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process -Filter "Name='_Total'" | Select-Object -First 1
 $l1 = @(Read-Hardware 'Win32_CacheMemory' @('Level','InstalledSize') | Where-Object { $_.Level -eq 3 })
 $r.cpu = @{ processors=@($p); currentMHz=($lp | Where-Object { $null -ne $_.ProcessorFrequency } | Measure-Object -Property ProcessorFrequency -Average).Average; logical=@($lp | Select-Object Name,PercentProcessorTime,ProcessorFrequency); system=$s | Select-Object Processes,Threads,SystemUpTime; handles=$handle.HandleCount; l1=@($l1 | Select-Object InstalledSize) }
}
if ($groups -contains 'memory') {
 $m = Read-Cim 'Win32_PerfFormattedData_PerfOS_Memory' | Select-Object -First 1
 $os = Read-Hardware 'Win32_OperatingSystem' @('TotalVisibleMemorySize') | Select-Object -First 1
 $r.memory = @{ counters=$m | Select-Object AvailableBytes,CacheBytes,StandbyCacheCoreBytes,StandbyCacheNormalPriorityBytes,StandbyCacheReserveBytes,ModifiedPageListBytes,CommittedBytes,CommitLimit,PoolPagedBytes,PoolNonpagedBytes; modules=@(Read-Hardware 'Win32_PhysicalMemory' @('Capacity','ConfiguredClockSpeed','SMBIOSMemoryType','FormFactor')); arrays=@(Read-Hardware 'Win32_PhysicalMemoryArray' @('MemoryDevices')); visibleKb=$os.TotalVisibleMemorySize }
}
if ($groups -contains 'disk') {
 $perf = Read-Cim 'Win32_PerfFormattedData_PerfDisk_PhysicalDisk'
 $rawperf = Read-Cim 'Win32_PerfRawData_PerfDisk_PhysicalDisk'
 $physical = @(Read-Hardware 'PhysicalDisks' @('DeviceId','SerialNumber','MediaType'))
 $disks = @(Read-Hardware 'Disks' @('Number','BusType','IsSystem'))
 $pagefilesKnown = $false; $pagefiles = @()
 try { $pagefiles = @(Get-CimInstance Win32_PageFileUsage -ErrorAction Stop); $pagefilesKnown = $true } catch {}
 $r.disks = @(foreach ($d in (Read-Hardware 'Win32_DiskDrive' @('Index','Model','Size','SerialNumber'))) {
  $sd = $disks | Where-Object { $_.Number -eq $d.Index } | Select-Object -First 1
  $c = $perf | Where-Object { ($_.Name -split ' ')[0] -eq [string]$d.Index } | Select-Object -First 1
  $rawc = $rawperf | Where-Object { ($_.Name -split ' ')[0] -eq [string]$d.Index } | Select-Object -First 1
  $pd = $physical | Where-Object { [string]$_.DeviceId -eq [string]$d.Index -and ([string]$d.SerialNumber).Trim() -ne '' -and ([string]$_.SerialNumber).Trim() -eq ([string]$d.SerialNumber).Trim() } | Select-Object -First 1
  $part = @(); $partKnown = $false; $formatted = $null
  try { $part = @(Get-Partition -DiskNumber $d.Index -ErrorAction Stop); $partKnown = $true; $vol = @($part | Get-Volume -ErrorAction Stop); if ($vol.Count -gt 0 -and @($vol | Where-Object { $null -eq $_.Size }).Count -eq 0) { $formatted = ($vol | Measure-Object Size -Sum).Sum } } catch {}
  $pf = if ($partKnown -and $pagefilesKnown -and $part.Count -gt 0) { @($part | Where-Object { $letter = [string]$_.DriveLetter; $letter -and ($pagefiles | Where-Object { $_.Name.StartsWith($letter + ':', [System.StringComparison]::OrdinalIgnoreCase) }) }).Count -gt 0 } else { $null }
  @{ id=[string]$d.Index; model=$d.Model; media=if($null -ne $pd){[string]$pd.MediaType}else{$null}; bus=if($null -ne $sd){[string]$sd.BusType}else{$null}; capacityBytes=$d.Size; formattedBytes=$formatted; system=if($null -ne $sd.IsSystem){[bool]$sd.IsSystem}else{$null}; pagefile=$pf; idle=$c.PercentIdleTime; readBps=$c.DiskReadBytesPersec; writeBps=$c.DiskWriteBytesPersec; latencyTicks=$rawc.AvgDisksecPerTransfer; latencyOperations=$rawc.AvgDisksecPerTransfer_Base; frequency=$rawc.Frequency_PerfTime }
 })
}
if ($groups -contains 'network') {
 $r.network = @(foreach ($a in (Get-NetAdapter)) {
  $ip = @(Get-NetIPAddress -InterfaceIndex $a.ifIndex)
  @{ name=$a.Name; state=[string]$a.Status; model=$a.InterfaceDescription; type=[string]$a.MediaType; ipv4=@($ip | Where-Object AddressFamily -eq IPv4 | ForEach-Object IPAddress); ipv6=@($ip | Where-Object AddressFamily -eq IPv6 | ForEach-Object IPAddress); dns=@(Get-DnsClientServerAddress -InterfaceIndex $a.ifIndex | ForEach-Object ServerAddresses); linkMbps=if($null -ne $a.TransmitLinkSpeed){$a.TransmitLinkSpeed / 1000000}else{$null}; mac=$a.MacAddress; duplex=$null }
 })
}
ConvertTo-Json -InputObject $r -Depth 8 -Compress
`;

export const DARWIN_PERFORMANCE_SCRIPTS: Record<PerformanceGroup, string> = {
  cpu: `printf '\\n@@SYSCTL\\n'; sysctl machdep.cpu.brand_string hw.cpufrequency hw.cpufrequency_max hw.packages hw.physicalcpu hw.logicalcpu hw.l1icachesize hw.l1dcachesize hw.l2cachesize hw.l3cachesize kern.boottime 2>/dev/null
printf '\\n@@COUNTS\\n'; ps -A -o thcount= 2>/dev/null | awk '{p++;t+=$1} END {if(p) print p,t}'
printf '\\n@@NOW\\n'; date +%s`,
  memory: `printf '\\n@@VM\\n'; vm_stat 2>/dev/null
printf '\\n@@MEMSIZE\\n'; sysctl -n hw.memsize 2>/dev/null`,
  disk: `printf '\\n@@MACDISKS\\n'; diskutil list physical -plist 2>/dev/null | plutil -convert json -o - - 2>/dev/null
for disk in $(diskutil list physical 2>/dev/null | awk '/^\\/dev\\/disk[0-9]+ / {sub("/dev/","",$1);print $1}' | sed -n '1,32p'); do printf '\\n@@MACDISK:%s\\n' "$disk"; diskutil info -plist "$disk" 2>/dev/null | plutil -convert json -o - - 2>/dev/null; done`,
  network: `printf '\\n@@IFCONFIG\\n'; ifconfig -a 2>/dev/null`,
};
export function buildPerformanceScript(
  platform: HostPlatform,
  groups: PerformanceGroup[],
  hardware: Record<string, unknown[]> = {},
): string {
  if (platform === "windows")
    return (
      "$groups = @(" +
      groups.map((g) => "'" + g + "'").join(",") +
      ")\n" +
      "$hardware = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" +
      Buffer.from(JSON.stringify(hardware)).toString("base64") +
      "')) | ConvertFrom-Json\n" +
      WINDOWS_PERFORMANCE_SCRIPT
    );
  const scripts =
    platform === "darwin"
      ? DARWIN_PERFORMANCE_SCRIPTS
      : LINUX_PERFORMANCE_SCRIPTS;
  return groups.map((g) => scripts[g]).join("\n");
}

export function numeric(v: unknown): number | null {
  if (
    (typeof v !== "number" && typeof v !== "string") ||
    (typeof v === "string" && !v.trim())
  )
    return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function json(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function arr(v: any): any[] {
  return Array.isArray(v) ? v : v != null ? [v] : [];
}
function sum(rows: any[], key: string): number | null {
  const nums = rows.map((r) => numeric(r?.[key]));
  return nums.length && nums.every((n) => n != null)
    ? nums.reduce<number>((s, n) => s + n!, 0)
    : null;
}
function scale(v: unknown, factor: number): number | null {
  const n = numeric(v);
  return n == null ? null : n * factor;
}
function emptyCpu(semantics: CpuDetails["semantics"]): CpuDetails {
  return {
    model: null,
    currentGHz: null,
    baseGHz: null,
    maxGHz: null,
    sockets: null,
    physicalCores: null,
    logicalCores: null,
    virtualization: null,
    l1Bytes: null,
    l2Bytes: null,
    l3Bytes: null,
    processes: null,
    threads: null,
    handles: null,
    uptimeSeconds: null,
    semantics,
  };
}
function emptyMemory(semantics: MemoryDetails["semantics"]): MemoryDetails {
  return {
    availableBytes: null,
    compressedBytes: null,
    committedBytes: null,
    commitLimitBytes: null,
    cachedBytes: null,
    pagedPoolBytes: null,
    nonpagedPoolBytes: null,
    reclaimableSlabBytes: null,
    unreclaimableSlabBytes: null,
    wiredBytes: null,
    installedBytes: null,
    hardwareReservedBytes: null,
    speedMHz: null,
    slotsUsed: null,
    slotsTotal: null,
    memoryType: null,
    formFactor: null,
    semantics,
  };
}
function emptyDisk(id: string): PhysicalDisk {
  return {
    id,
    model: null,
    media: null,
    bus: null,
    capacityBytes: null,
    formattedBytes: null,
    system: null,
    pagefile: null,
    activePercent: null,
    readBps: null,
    writeBps: null,
    latencyMs: null,
  };
}
function emptyAdapter(): AdapterDetails {
  return {
    model: null,
    type: null,
    ipv4: null,
    ipv6: null,
    dns: null,
    linkMbps: null,
    mac: null,
    duplex: null,
  };
}
export interface PerformanceSample {
  at: number;
  uptime: number | null;
  cpu: Record<string, number[]>;
  disks: Record<string, number[]>;
  hardware?: HardwareCache;
}
export type PerformanceSamples = Map<number, PerformanceSample>;
export interface PerformanceResult {
  cpu?: CpuDetails;
  perCore?: Array<number | null>;
  coreIds?: string[];
  memory?: MemoryDetails;
  devices?: PhysicalDisk[];
  adapters?: Record<string, AdapterDetails>;
  adapterStates?: Record<string, string>;
}
function sections(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of output.split(/(?:^|\n)@@/).slice(1)) {
    const i = part.indexOf("\n");
    if (i >= 0) result[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return result;
}
function cacheBytes(v: unknown): number | null {
  if (typeof v !== "string") return numeric(v);
  const m = v.match(/^([\d.]+)\s*([KMG])?(?:i?B)?(?:\s|$)/i);
  return m
    ? scale(
        m[1],
        { K: 1024, M: 1048576, G: 1073741824 }[m[2]?.toUpperCase() ?? ""] ?? 1,
      )
    : null;
}
function difference(
  current: number[],
  previous: number[] | undefined,
): number[] | null {
  if (
    !previous ||
    current.length !== previous.length ||
    current.some((n, i) => !Number.isFinite(n) || n < previous[i])
  )
    return null;
  return current.map((n, i) => n - previous[i]);
}

export function parsePerformance(
  output: string,
  platform: HostPlatform,
  previous?: PerformanceSample,
  at = Date.now(),
): { result: PerformanceResult; sample: PerformanceSample } {
  const result: PerformanceResult = {};
  const sample: PerformanceSample = { at, uptime: null, cpu: {}, disks: {} };
  if (platform === "windows") {
    const raw = json(output);
    if (!raw || typeof raw !== "object") return { result, sample };
    if (raw.cpu) {
      const c = emptyCpu("windows"),
        ps = arr(raw.cpu.processors),
        p = ps[0],
        sys = raw.cpu.system;
      c.model = str(p?.Name);
      c.currentGHz = scale(
        "currentMHz" in raw.cpu ? raw.cpu.currentMHz : p?.CurrentClockSpeed,
        0.001,
      );
      c.maxGHz = scale(p?.MaxClockSpeed, 0.001);
      c.sockets = ps.length || null;
      c.physicalCores = sum(ps, "NumberOfCores");
      c.logicalCores = sum(ps, "NumberOfLogicalProcessors");
      c.virtualization =
        ps.length &&
        ps.every((p) => typeof p.VirtualizationFirmwareEnabled === "boolean")
          ? ps.some((p) => p.VirtualizationFirmwareEnabled)
            ? "enabled"
            : "disabled"
          : null;
      c.l1Bytes = scale(sum(arr(raw.cpu.l1), "InstalledSize"), 1024);
      c.l2Bytes = scale(sum(ps, "L2CacheSize"), 1024);
      c.l3Bytes = scale(sum(ps, "L3CacheSize"), 1024);
      c.processes = numeric(sys?.Processes);
      c.threads = numeric(sys?.Threads);
      c.handles = numeric(raw.cpu.handles);
      c.uptimeSeconds = numeric(sys?.SystemUpTime);
      result.cpu = c;
      const logical = arr(raw.cpu.logical);
      result.coreIds = logical.map((p) => String(p.Name));
      result.perCore = logical.map((p) => {
        const n = numeric(p.PercentProcessorTime);
        return n != null && n <= 100 ? n : null;
      });
    }
    if (raw.memory) {
      const m = emptyMemory("windows"),
        r = raw.memory,
        c = r.counters,
        modules = arr(r.modules);
      for (const [key, source] of Object.entries({
        availableBytes: "AvailableBytes",
        committedBytes: "CommittedBytes",
        commitLimitBytes: "CommitLimit",
        pagedPoolBytes: "PoolPagedBytes",
        nonpagedPoolBytes: "PoolNonpagedBytes",
      }))
        (m as any)[key] = numeric(c?.[source]);
      const cacheKeys = [
        "StandbyCacheCoreBytes",
        "StandbyCacheNormalPriorityBytes",
        "StandbyCacheReserveBytes",
        "ModifiedPageListBytes",
      ];
      const cacheValues = cacheKeys.map((k) => numeric(c?.[k]));
      m.cachedBytes = cacheValues.every((n) => n != null)
        ? cacheValues.reduce<number>((a, b) => a + b!, 0)
        : null;
      m.installedBytes = sum(modules, "Capacity");
      m.slotsUsed = modules.length || null;
      m.slotsTotal = sum(arr(r.arrays), "MemoryDevices");
      const unique = (key: string) => {
        const values = [
          ...new Set(
            modules
              .map((p) => numeric(p[key]))
              .filter((n) => n != null && n > 0),
          ),
        ];
        return values.length ? values.join(" / ") : null;
      };
      const speeds = modules.map((p) => numeric(p.ConfiguredClockSpeed));
      m.speedMHz =
        speeds.length && speeds.every((n) => n != null && n > 0)
          ? Math.min(...(speeds as number[]))
          : null;
      const types: Record<number, string> = {
        20: "DDR",
        21: "DDR2",
        24: "DDR3",
        26: "DDR4",
        30: "LPDDR4",
        34: "DDR5",
        35: "LPDDR5",
      };
      const forms: Record<number, string> = { 8: "DIMM", 12: "SODIMM" };
      m.memoryType =
        unique("SMBIOSMemoryType")
          ?.split(" / ")
          .map((t) => types[Number(t)] ?? `SMBIOS ${t}`)
          .join(" / ") ?? null;
      m.formFactor =
        unique("FormFactor")
          ?.split(" / ")
          .map((t) => forms[Number(t)] ?? `SMBIOS ${t}`)
          .join(" / ") ?? null;
      const visible = scale(r.visibleKb, 1024);
      m.hardwareReservedBytes =
        m.installedBytes != null &&
        visible != null &&
        m.installedBytes >= visible
          ? m.installedBytes - visible
          : null;
      result.memory = m;
    }
    if (Array.isArray(raw.disks))
      result.devices = raw.disks
        .filter((d: any) => str(d.id) != null)
        .map((d: any) => {
          const v = emptyDisk(d.id);
          for (const key of ["model", "media", "bus"] as const)
            v[key] = str(d[key]);
          for (const key of [
            "capacityBytes",
            "formattedBytes",
            "readBps",
            "writeBps",
          ] as const)
            v[key] = numeric(d[key]);
          v.system = typeof d.system === "boolean" ? d.system : null;
          v.pagefile = typeof d.pagefile === "boolean" ? d.pagefile : null;
          const idle = numeric(d.idle);
          v.activePercent = idle != null && idle <= 100 ? 100 - idle : null;
          const ticks = numeric(d.latencyTicks),
            ops = numeric(d.latencyOperations),
            frequency = numeric(d.frequency);
          if (ticks != null && ops != null) {
            sample.disks[d.id] = [ticks, ops];
            const delta = difference([ticks, ops], previous?.disks[d.id]);
            if (delta && delta[1] > 0 && frequency != null && frequency > 0)
              v.latencyMs = (delta[0] / frequency / delta[1]) * 1000;
          }
          return v;
        });
    if (Array.isArray(raw.network)) {
      result.adapters = {};
      result.adapterStates = {};
      for (const a of raw.network) {
        if (!str(a.name)) continue;
        const d = emptyAdapter();
        for (const k of ["model", "type", "mac", "duplex"] as const)
          d[k] = str(a[k]);
        for (const k of ["ipv4", "ipv6", "dns"] as const)
          d[k] = Array.isArray(a[k])
            ? a[k].filter((v: unknown) => str(v) != null)
            : null;
        d.linkMbps = numeric(a.linkMbps);
        result.adapters[a.name] = d;
        result.adapterStates![a.name] =
          str(a.state)?.toUpperCase() ?? "UNKNOWN";
      }
    }
    return { result, sample };
  }
  const s = sections(output);
  if (platform === "linux") {
    sample.uptime = numeric(
      s.UPTIME?.split(/\s+/)[0] ?? s.DISKUPTIME?.split(/\s+/)[0],
    );
    const reboot =
      previous?.uptime != null &&
      sample.uptime != null &&
      sample.uptime < previous.uptime;
    if ("CPU" in s) {
      const c = emptyCpu("linux");
      const fields: Record<string, string> = {};
      for (const line of s.CPU.split("\n")) {
        const m = line.match(/^([^:]+):\s*(.*)/);
        if (m && !(m[1].trim() in fields)) fields[m[1].trim()] = m[2];
      }
      const ls: Record<string, string> = {};
      for (const row of arr(json(s.LSCPU)?.lscpu))
        ls[String(row.field).replace(/:$/, "")] = String(row.data);
      c.model = str(
        fields["model name"] ?? ls["Model name"] ?? fields.Processor,
      );
      c.currentGHz = scale(fields["cpu MHz"], 0.001);
      c.baseGHz = scale(s.FREQ, 0.000001);
      c.sockets = numeric(ls["Socket(s)"]);
      c.logicalCores = numeric(ls["CPU(s)"]);
      const per = numeric(ls["Core(s) per socket"]);
      c.physicalCores =
        c.sockets != null && per != null ? c.sockets * per : null;
      c.virtualization = str(ls["Virtualization"])
        ? `hardware support: ${ls.Virtualization}`
        : null;
      c.l1Bytes =
        cacheBytes(ls["L1d cache"]) != null &&
        cacheBytes(ls["L1i cache"]) != null
          ? cacheBytes(ls["L1d cache"])! + cacheBytes(ls["L1i cache"])!
          : null;
      c.l2Bytes = cacheBytes(ls["L2 cache"]);
      c.l3Bytes = cacheBytes(ls["L3 cache"]);
      const counts = s.COUNTS?.split(/\s+/);
      c.processes = numeric(counts?.[0]);
      c.threads = numeric(counts?.[1]);
      const handles = s.HANDLES?.split(/\s+/).map(numeric);
      c.handles =
        handles?.[0] != null && handles?.[1] != null && handles[0] >= handles[1]
          ? handles[0] - handles[1]
          : null;
      c.uptimeSeconds = sample.uptime;
      result.cpu = c;
      result.coreIds = [];
      result.perCore = [];
      for (const line of (s.STAT ?? "").split("\n")) {
        const p = line.trim().split(/\s+/);
        if (!/^cpu\d+$/.test(p[0]) || p.length < 5) continue;
        const ns = p.slice(1, 9).map(numeric);
        if (ns.some((n) => n == null)) continue;
        const values = ns as number[];
        sample.cpu[p[0]] = values;
        const delta = !reboot ? difference(values, previous?.cpu[p[0]]) : null;
        const total = delta?.reduce((a, b) => a + b, 0) ?? 0;
        const idle = delta ? delta[3] + (delta[4] ?? 0) : 0;
        result.coreIds.push(p[0].slice(3));
        result.perCore.push(total > 0 ? ((total - idle) / total) * 100 : null);
      }
    }
    if ("MEM" in s) {
      const m = emptyMemory("linux"),
        vals: Record<string, number> = {};
      for (const line of s.MEM.split("\n")) {
        const p = line.match(/^(\w+):\s+(\d+)\s+kB/);
        if (p) vals[p[1]] = Number(p[2]) * 1024;
      }
      m.availableBytes = vals.MemAvailable ?? null;
      m.committedBytes = vals.Committed_AS ?? null;
      m.commitLimitBytes = vals.CommitLimit ?? null;
      m.cachedBytes =
        vals.Cached != null && vals.Buffers != null
          ? vals.Cached + vals.Buffers
          : null;
      m.reclaimableSlabBytes = vals.SReclaimable ?? null;
      m.unreclaimableSlabBytes = vals.SUnreclaim ?? null;
      result.memory = m;
    }
    if ("BLOCK" in s) {
      const blocks = arr(json(s.BLOCK)?.blockdevices).filter(
        (d) => d.type === "disk",
      );
      const counters: Record<string, number[]> = {};
      for (const line of (s.DISKSTATS ?? "").split("\n")) {
        const p = line.trim().split(/\s+/);
        if (p.length >= 14) {
          const ns = [p[3], p[5], p[6], p[7], p[9], p[10], p[12]].map(numeric);
          if (ns.every((n) => n != null)) counters[p[2]] = ns as number[];
        }
      }
      const elapsed = previous ? (at - previous.at) / 1000 : 0;
      result.devices = blocks.map((b) => {
        const d = emptyDisk(String(b.name));
        d.model = str(b.model);
        d.bus = str(b.tran);
        d.capacityBytes = numeric(b.size);
        d.media =
          b.rota === true || b.rota === 1
            ? "rotational"
            : b.rota === false || b.rota === 0
              ? "non-rotational"
              : null;
        const now = counters[b.name];
        if (now) sample.disks[b.name] = now;
        const delta =
          now && !reboot ? difference(now, previous?.disks[b.name]) : null;
        if (delta && elapsed > 0) {
          d.readBps = (delta[1] * 512) / elapsed;
          d.writeBps = (delta[4] * 512) / elapsed;
          d.activePercent = Math.min(100, delta[6] / (elapsed * 10));
          const ops = delta[0] + delta[3];
          d.latencyMs = ops > 0 ? (delta[2] + delta[5]) / ops : null;
        }
        return d;
      });
    }
    if ("ADDR" in s || "LINKS" in s) {
      result.adapters = {};
      for (const a of arr(json(s.ADDR))) {
        if (!str(a.ifname)) continue;
        const d = emptyAdapter();
        d.ipv4 = arr(a.addr_info)
          .filter((v) => v.family === "inet")
          .map((v) => v.local);
        d.ipv6 = arr(a.addr_info)
          .filter((v) => v.family === "inet6")
          .map((v) => v.local);
        d.mac = str(a.address);
        d.type = str(a.link_type);
        result.adapters[a.ifname] = d;
      }
      for (const line of (s.LINKS ?? "").split("\n")) {
        const [name, speed, duplex, type, mac, driver] = line.split("|");
        if (!name) continue;
        const d = result.adapters[name] ?? emptyAdapter();
        d.linkMbps = numeric(speed);
        d.duplex = str(duplex);
        d.mac = str(mac);
        d.model =
          driver && driver !== name && driver !== "driver" ? str(driver) : null;
        d.type =
          type === "1" ? "Ethernet" : type === "772" ? "loopback" : str(type);
        result.adapters[name] = d;
      }
      for (const line of (s.DNS ?? "").split("\n")) {
        const match = line.match(/^Link \d+ \(([^)]+)\):\s*(.*)/);
        if (match && result.adapters[match[1]])
          result.adapters[match[1]].dns = match[2].trim()
            ? match[2].trim().split(/\s+/)
            : [];
      }
    }
  } else {
    if ("SYSCTL" in s) {
      const vals: Record<string, string> = {};
      for (const line of s.SYSCTL.split("\n")) {
        const i = line.indexOf(":");
        if (i >= 0) vals[line.slice(0, i)] = line.slice(i + 1).trim();
      }
      const c = emptyCpu("darwin");
      c.model = str(vals["machdep.cpu.brand_string"]);
      c.currentGHz = scale(vals["hw.cpufrequency"], 1e-9);
      c.maxGHz = scale(vals["hw.cpufrequency_max"], 1e-9);
      c.sockets = numeric(vals["hw.packages"]);
      c.physicalCores = numeric(vals["hw.physicalcpu"]);
      c.logicalCores = numeric(vals["hw.logicalcpu"]);
      c.l2Bytes = numeric(vals["hw.l2cachesize"]);
      c.l3Bytes = numeric(vals["hw.l3cachesize"]);
      const l1i = numeric(vals["hw.l1icachesize"]),
        l1d = numeric(vals["hw.l1dcachesize"]);
      c.l1Bytes = l1i != null && l1d != null ? l1i + l1d : null;
      const boot = vals["kern.boottime"]?.match(/sec = (\d+)/);
      const now = numeric(s.NOW);
      c.uptimeSeconds =
        boot && now != null ? Math.max(0, now - Number(boot[1])) : null;
      const counts = s.COUNTS?.split(/\s+/);
      c.processes = numeric(counts?.[0]);
      c.threads = numeric(counts?.[1]);
      result.cpu = c;
    }
    if ("VM" in s) {
      const m = emptyMemory("darwin");
      const page = s.VM.match(/page size of (\d+) bytes/);
      const vals: Record<string, number> = {};
      for (const line of s.VM.split("\n")) {
        const p = line.match(/^([^:]+):\s*(\d+)\./);
        if (p && page) vals[p[1]] = Number(p[2]) * Number(page[1]);
      }
      m.compressedBytes = vals["Pages occupied by compressor"] ?? null;
      m.wiredBytes = vals["Pages wired down"] ?? null;
      m.cachedBytes = vals["File-backed pages"] ?? null;
      m.installedBytes = numeric(s.MEMSIZE);
      result.memory = m;
    }
    if ("MACDISKS" in s) {
      result.devices = arr(json(s.MACDISKS)?.AllDisksAndPartitions).map((b) => {
        const d = emptyDisk(String(b.DeviceIdentifier));
        d.capacityBytes = numeric(b.Size);
        const info = json(s[`MACDISK:${d.id}`]);
        if (info) {
          d.model = str(info.MediaName);
          d.bus = str(info.BusProtocol);
          d.media =
            typeof info.SolidState === "boolean"
              ? info.SolidState
                ? "SSD"
                : "HDD"
              : null;
        }
        return d;
      });
    }
    if ("IFCONFIG" in s) {
      result.adapters = {};
      let d: AdapterDetails | undefined;
      for (const line of s.IFCONFIG.split("\n")) {
        const match = line.match(/^(\S+):/);
        if (match) {
          d = emptyAdapter();
          d.ipv4 = [];
          d.ipv6 = [];
          result.adapters[match[1]] = d;
        }
        if (!d) continue;
        const v4 = line.match(/^\s+inet (\S+)/),
          v6 = line.match(/^\s+inet6 (\S+)/),
          mac = line.match(/^\s+ether (\S+)/),
          media = line.match(/^\s+media: (.+)/);
        if (v4) d.ipv4!.push(v4[1]);
        if (v6) d.ipv6!.push(v6[1]);
        if (mac) d.mac = mac[1];
        if (media) {
          d.type = media[1];
          const speed = media[1].match(/(\d+)base/);
          d.linkMbps = speed ? Number(speed[1]) : null;
          d.duplex = media[1].includes("full-duplex") ? "full" : null;
        }
      }
    }
  }
  return { result, sample };
}

/** Enrichment never replaces baseline metrics and never escalates privileges. */
export async function collectPerformance(
  client: Client,
  platform: HostPlatform,
  hostId: number,
  samples: PerformanceSamples,
  groups: PerformanceGroup[],
): Promise<PerformanceResult> {
  if (!groups.length) return {};
  try {
    const previous = samples.get(hostId);
    const now = Date.now();
    const hardware = Object.fromEntries(
      Object.entries(platform === "windows" ? (previous?.hardware ?? {}) : {})
        .filter(
          ([, value]) =>
            now >= value.at && now - value.at < HARDWARE_REFRESH_MS,
        )
        .map(([name, value]) => [name, value.rows]),
    );
    const script = buildPerformanceScript(platform, groups, hardware);
    const output =
      platform === "windows"
        ? await execPowerShell(client, script, 15000)
        : await execCommand(client, script, 15000);
    const parsed = parsePerformance(output.stdout, platform, previous);
    if (platform === "windows") {
      const rows = json(output.stdout)?.hardware;
      if (rows && typeof rows === "object" && !Array.isArray(rows))
        parsed.sample.hardware = Object.fromEntries(
          Object.entries(rows)
            .filter(([, value]) => Array.isArray(value))
            .map(([name, value]) => [
              name,
              {
                at: Object.hasOwn(hardware, name)
                  ? previous!.hardware![name].at
                  : now,
                rows: value as unknown[],
              },
            ]),
        );
    }
    samples.set(hostId, parsed.sample);
    return parsed.result;
  } catch {
    samples.delete(hostId);
    return {};
  }
}
export function enrichPerformance(
  metrics: Pick<ServerMetrics, "cpu" | "memory" | "disk" | "network">,
  extra: PerformanceResult,
): void {
  if (extra.cpu) metrics.cpu.details = extra.cpu;
  if (extra.perCore) {
    metrics.cpu.perCore = extra.perCore;
    metrics.cpu.coreIds = extra.coreIds;
  }
  if (extra.memory) metrics.memory.details = extra.memory;
  if (extra.devices) metrics.disk.devices = extra.devices;
  if (extra.adapters) {
    metrics.network ??= { interfaces: [] };
    metrics.network.interfaces ??= [];
    for (const [name, details] of Object.entries(extra.adapters)) {
      const iface = metrics.network.interfaces.find((i) => i.name === name);
      if (iface) iface.details = details;
      else
        metrics.network.interfaces.push({
          name,
          ip: details.ipv4?.[0] ?? details.ipv6?.[0] ?? "",
          state: extra.adapterStates?.[name] ?? "UNKNOWN",
          details,
          rxRateBps: null,
          txRateBps: null,
        });
    }
  }
}
