import { afterEach, describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";
import type { Client } from "ssh2";
import {
  execCommand,
  execPowerShell,
} from "@termix-ssh/plugin-sdk/host-commands";
import {
  buildPerformanceScript,
  collectPerformance,
  enrichPerformance,
  HARDWARE_REFRESH_MS,
  numeric,
  parsePerformance,
  type PerformanceSamples,
} from "../../../src/backend/widgets/performance-collector.js";
import { createMetricsState } from "../../../src/backend/state.js";
vi.mock("@termix-ssh/plugin-sdk/host-commands", () => ({
  execCommand: vi.fn(),
  execPowerShell: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

function scriptHardware(script: string) {
  const encoded = script.match(/FromBase64String\('([^']+)'\)/)![1];
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}
const linux = (tick = 100, busy = 2000, uptime = 100) => `
@@CPU
model name : Fixture CPU
cpu MHz : 3200
@@LSCPU
{"lscpu":[{"field":"Socket(s):","data":"1"},{"field":"Core(s) per socket:","data":"2"},{"field":"CPU(s):","data":"4"},{"field":"Virtualization:","data":"VT-x"},{"field":"L1d cache:","data":"64K"},{"field":"L1i cache:","data":"64 KiB (2 instances)"},{"field":"L3 cache:","data":"8388608"}]}
@@FREQ
2400000
@@STAT
cpu0 ${tick} 0 0 ${tick} 0 0 0 0 999 0
cpu2 ${tick} 0 0 ${tick} 0 0 0 0
@@UPTIME
${uptime} 10
@@COUNTS
42 168
@@HANDLES
1000 10 100000
@@MEM
MemTotal: 1024000 kB
MemAvailable: 0 kB
Cached: 1000 kB
Buffers: 200 kB
Committed_AS: 2048 kB
CommitLimit: 4096 kB
SReclaimable: 32 kB
SUnreclaim: 16 kB
@@BLOCK
{"blockdevices":[{"name":"sda","type":"disk","size":10000000,"rota":false,"model":"SSD fixture","tran":"sata","children":[{"name":"sda1","type":"part"}]},{"name":"dm-0","type":"lvm","size":2000000},{"name":"sda1","type":"part","size":10000}]}
@@DISKSTATS
8 0 sda ${tick} 0 ${tick * 10} ${tick * 2} ${tick} 0 ${tick * 20} ${tick * 3} 0 ${busy} 0
8 1 sda1 9999 0 9999 9999 9999 0 9999 9999 0 9999 0
@@ADDR
[{"ifname":"eth0","address":"aa:bb","link_type":"ether","addr_info":[{"family":"inet","local":"192.0.2.1"},{"family":"inet6","local":"2001:db8::1"}]}]
@@DNS
Link 2 (eth0): 192.0.2.53 2001:db8::53
Global: 198.51.100.53
@@LINKS
eth0|1000|full|1|aa:bb|virtio_net
lo|-1||772|00:00|lo
`;
const windows = (ticks = 2000000, ops = 100) =>
  JSON.stringify({
    cpu: {
      processors: [
        {
          Name: "Fixture Ryzen",
          CurrentClockSpeed: 3500,
          MaxClockSpeed: 4000,
          NumberOfCores: 8,
          NumberOfLogicalProcessors: 16,
          VirtualizationFirmwareEnabled: null,
          L2CacheSize: 4096,
          L3CacheSize: 32768,
        },
      ],
      logical: [
        { Name: "0,0", PercentProcessorTime: 25 },
        { Name: "0,1", PercentProcessorTime: null },
      ],
      system: { Processes: 200, Threads: 3000, SystemUpTime: 3600 },
      handles: null,
      l1: [],
    },
    memory: {
      counters: {
        AvailableBytes: 1000,
        StandbyCacheCoreBytes: 100,
        StandbyCacheNormalPriorityBytes: 200,
        StandbyCacheReserveBytes: 300,
        ModifiedPageListBytes: 400,
        CacheBytes: 99999,
        CommittedBytes: "4096",
        CommitLimit: 8192,
        PoolPagedBytes: null,
        PoolNonpagedBytes: 2048,
      },
      modules: [
        {
          Capacity: 8192,
          ConfiguredClockSpeed: 3200,
          SMBIOSMemoryType: 26,
          FormFactor: 8,
        },
      ],
      arrays: [{ MemoryDevices: 2 }],
      visibleKb: 7,
    },
    disks: [
      {
        id: "0",
        model: "Fixture SSD",
        media: "SSD",
        bus: "NVMe",
        capacityBytes: "100000",
        formattedBytes: 90000,
        system: true,
        pagefile: null,
        idle: 80,
        readBps: 4096,
        writeBps: 8192,
        latencyTicks: ticks,
        latencyOperations: ops,
        frequency: 10000000,
      },
    ],
    network: [
      {
        name: "Ethernet",
        state: "Up",
        model: "Fixture NIC",
        type: "802.3",
        ipv4: ["192.0.2.1"],
        ipv6: ["2001:db8::1"],
        dns: ["192.0.2.53"],
        linkMbps: 1000,
      },
    ],
  });

describe("remote performance fixtures", () => {
  it("retains nullable numerics, not null/empty/boolean coercions", () => {
    for (const value of [
      null,
      undefined,
      "",
      " ",
      false,
      NaN,
      Infinity,
      -1,
      "denied",
    ])
      expect(numeric(value)).toBeNull();
    expect(numeric("0")).toBe(0);
    expect(numeric("1.25")).toBe(1.25);
  });
  it("Linux topology, cache, explicit memory equivalents, and per-interface details", () => {
    const { result } = parsePerformance(linux(), "linux", undefined, 1000);
    expect(result.cpu).toMatchObject({
      model: "Fixture CPU",
      currentGHz: 3.2,
      baseGHz: 2.4,
      sockets: 1,
      physicalCores: 2,
      logicalCores: 4,
      l1Bytes: 131072,
      l3Bytes: 8388608,
      processes: 42,
      threads: 168,
      handles: 990,
      virtualization: "hardware support: VT-x",
    });
    expect(result.memory).toMatchObject({
      availableBytes: 0,
      cachedBytes: 1228800,
      committedBytes: 2097152,
      pagedPoolBytes: null,
      nonpagedPoolBytes: null,
      installedBytes: null,
      compressedBytes: null,
      reclaimableSlabBytes: 32768,
    });
    expect(result.coreIds).toEqual(["0", "2"]);
    expect(result.perCore).toEqual([null, null]);
    expect(result.adapters?.eth0).toMatchObject({
      ipv4: ["192.0.2.1"],
      ipv6: ["2001:db8::1"],
      dns: ["192.0.2.53", "2001:db8::53"],
      linkMbps: 1000,
      model: "virtio_net",
    });
    expect(result.adapters?.lo.linkMbps).toBeNull();
    expect(result.adapters?.lo.model).toBeNull();
  });
  it("Linux physical counters exclude partitions and guest CPU double-counting", () => {
    const first = parsePerformance(linux(), "linux", undefined, 1000);
    const { result } = parsePerformance(
      linux(200, 2500, 101),
      "linux",
      first.sample,
      2000,
    );
    expect(result.perCore).toEqual([50, 50]);
    expect(result.devices).toHaveLength(1);
    expect(result.devices?.[0]).toMatchObject({
      id: "sda",
      activePercent: 50,
      readBps: 512000,
      writeBps: 1024000,
      latencyMs: 2.5,
      formattedBytes: null,
      system: null,
      pagefile: null,
    });
    expect(first.result.devices?.[0].activePercent).toBeNull();
  });
  it("counter resets, reboot, missing counters and nonpositive intervals remain gaps", () => {
    const first = parsePerformance(linux(200, 2500), "linux", undefined, 2000);
    for (const [out, at] of [
      [linux(100, 2000), 3000],
      [linux(300, 3000, 1), 3000],
      [linux(300, 3000), 2000],
    ] as const) {
      const { result } = parsePerformance(out, "linux", first.sample, at);
      expect(result.devices?.[0].activePercent).toBeNull();
    }
    const reset = parsePerformance(
      linux(100, 2000),
      "linux",
      first.sample,
      3000,
    );
    expect(reset.result.perCore).toEqual([null, null]);
    const missing = parsePerformance(
      "\n@@MEM\nPermission denied\n@@BLOCK\nnot json",
      "linux",
    );
    expect(missing.result.memory?.availableBytes).toBeNull();
    expect(missing.result.devices).toEqual([]);
  });
  it("Windows uses standby plus modified cache, preserves unknown firmware, and measures raw latency deltas", () => {
    const first = parsePerformance(windows(), "windows", undefined, 1000),
      next = parsePerformance(
        windows(22000000, 200),
        "windows",
        first.sample,
        2000,
      );
    expect(first.result.cpu).toMatchObject({
      virtualization: null,
      baseGHz: null,
      maxGHz: 4,
      handles: null,
      physicalCores: 8,
      l1Bytes: null,
    });
    expect(first.result.perCore).toEqual([25, null]);
    expect(first.result.memory).toMatchObject({
      cachedBytes: 1000,
      compressedBytes: null,
      pagedPoolBytes: null,
      memoryType: "DDR4",
      formFactor: "DIMM",
      slotsUsed: 1,
      slotsTotal: 2,
      hardwareReservedBytes: 1024,
    });
    expect(first.result.devices?.[0]).toMatchObject({
      activePercent: 20,
      latencyMs: null,
      media: "SSD",
      bus: "NVMe",
      system: true,
      pagefile: null,
    });
    expect(next.result.devices?.[0].latencyMs).toBeCloseTo(20);
    expect(
      parsePerformance(windows(1, 1), "windows", next.sample, 3000).result
        .devices?.[0].latencyMs,
    ).toBeNull();
    expect(next.result.adapters?.Ethernet.linkMbps).toBe(1000);
  });
  it("macOS uses actual page size and native memory semantics; no invented per-core data", () => {
    const raw = `\n@@SYSCTL\nmachdep.cpu.brand_string: Apple fixture\nhw.logicalcpu: 8\nhw.physicalcpu: 8\nhw.cpufrequency_max: 3200000000\nkern.boottime: { sec = 100, usec = 0 }\n@@NOW\n400\n@@VM\nMach Virtual Memory Statistics: (page size of 16384 bytes)\nPages occupied by compressor: 100.\nPages wired down: 200.\nFile-backed pages: 50.\n@@MEMSIZE\n17179869184\n@@MACDISKS\n{"AllDisksAndPartitions":[{"DeviceIdentifier":"disk0","Size":1000000}]}\n@@MACDISK:disk0\n{"MediaName":"Apple SSD","BusProtocol":"Apple Fabric","SolidState":true}\n@@IFCONFIG\nen0: flags=8863<UP>\n    inet 192.0.2.2 netmask 0xffffff00\n    inet6 fe80::1%en0 prefixlen 64\n    media: autoselect (1000baseT <full-duplex>)`;
    const { result } = parsePerformance(raw, "darwin");
    expect(result.cpu).toMatchObject({
      model: "Apple fixture",
      logicalCores: 8,
      baseGHz: null,
      maxGHz: 3.2,
      uptimeSeconds: 300,
    });
    expect(result.perCore).toBeUndefined();
    expect(result.memory).toMatchObject({
      compressedBytes: 1638400,
      wiredBytes: 3276800,
      cachedBytes: 819200,
      pagedPoolBytes: null,
    });
    expect(result.devices?.[0]).toMatchObject({
      id: "disk0",
      model: "Apple SSD",
      media: "SSD",
      activePercent: null,
      readBps: null,
      latencyMs: null,
    });
    expect(result.adapters?.en0).toMatchObject({
      ipv4: ["192.0.2.2"],
      ipv6: ["fe80::1%en0"],
      linkMbps: 1000,
      dns: null,
    });
  });
  it("enrichment preserves filesystem utilization and baseline values, adding down interfaces", () => {
    const metrics = {
      cpu: { percent: 70, cores: 2, load: null },
      memory: { percent: 20, usedGiB: 2, totalGiB: 10 },
      disk: { percent: 95, usedHuman: "95G", totalHuman: "100G" },
      network: {
        interfaces: [
          { name: "Ethernet", ip: "192.0.2.1", state: "UP", rxRateBps: 123 },
        ],
      },
    };
    const extra = parsePerformance(windows(), "windows").result;
    extra.adapters!["Disabled NIC"] = { ...extra.adapters!.Ethernet };
    extra.adapterStates!["Disabled NIC"] = "DISCONNECTED";
    enrichPerformance(metrics, extra);
    expect(metrics.cpu.percent).toBe(70);
    expect(metrics.disk.percent).toBe(95);
    expect(metrics.memory.usedGiB).toBe(2);
    expect(metrics.network.interfaces[0].rxRateBps).toBe(123);
    expect(metrics.network.interfaces[1]).toMatchObject({
      name: "Disabled NIC",
      state: "DISCONNECTED",
      rxRateBps: null,
    });
  });
  it("exports exact scripts with group gates and no presentation settings dependency", () => {
    const script = buildPerformanceScript("linux", ["memory"]);
    expect(script).toContain("/proc/meminfo");
    expect(script).not.toContain("lsblk");
    expect(script).not.toContain("ps -e");
    expect(buildPerformanceScript("windows", ["network"])).toContain(
      "$groups = @('network')",
    );
    for (const platform of ["linux", "darwin", "windows"] as const)
      expect(buildPerformanceScript(platform, ["cpu", "disk"])).not.toMatch(
        /sudo|Install-|apt-get/,
      );
  });
  it("collector consumes stdout, isolates hosts, fails soft, and clears host-owned samples", async () => {
    const samples: PerformanceSamples = new Map(),
      client = {} as Client;
    vi.mocked(execCommand).mockResolvedValue({
      stdout: linux(),
      stderr: "",
      code: 0,
    } as any);
    expect(
      (await collectPerformance(client, "linux", 1, samples, ["cpu"])).cpu
        ?.model,
    ).toBe("Fixture CPU");
    expect(samples.has(1)).toBe(true);
    expect(
      (await collectPerformance(client, "linux", 2, samples, ["cpu"])).perCore,
    ).toEqual([null, null]);
    vi.mocked(execPowerShell).mockRejectedValue(new Error("Permission denied"));
    expect(
      await collectPerformance(client, "windows", 1, samples, ["disk"]),
    ).toEqual({});
    expect(samples.has(1)).toBe(false);
    vi.mocked(execCommand).mockClear();
    expect(await collectPerformance(client, "linux", 1, samples, [])).toEqual(
      {},
    );
    expect(execCommand).not.toHaveBeenCalled();
    const state = createMetricsState();
    state.rateSamples.performance.set(2, {
      at: 1,
      uptime: null,
      cpu: {},
      disks: {},
    });
    state.rateSamples.clear(2);
    expect(state.rateSamples.performance.size).toBe(0);
  });

  it("reuses only per-host static hardware without sliding its refresh or caching dynamic counters", async () => {
    const samples: PerformanceSamples = new Map();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const raw = JSON.parse(windows());
    raw.cpu.currentMHz = 3500;
    raw.hardware = { Win32_Processor: raw.cpu.processors };
    vi.mocked(execPowerShell).mockResolvedValue({
      stdout: JSON.stringify(raw),
    } as any);
    await collectPerformance({} as Client, "windows", 1, samples, ["cpu"]);
    now.mockReturnValue(2000);
    raw.cpu.currentMHz = null;
    raw.cpu.system = null;
    raw.cpu.logical = [];
    raw.memory.counters = null;
    raw.disks[0].readBps = null;
    raw.network[0].linkMbps = null;
    vi.mocked(execPowerShell).mockResolvedValue({
      stdout: JSON.stringify(raw),
    } as any);
    const missing = await collectPerformance(
      {} as Client,
      "windows",
      1,
      samples,
      ["cpu", "memory", "disk", "network"],
    );
    expect(missing.cpu).toMatchObject({
      currentGHz: null,
      processes: null,
      uptimeSeconds: null,
    });
    expect(missing.perCore).toEqual([]);
    expect(missing.memory?.availableBytes).toBeNull();
    expect(missing.devices?.[0].readBps).toBeNull();
    expect(missing.adapters?.Ethernet.linkMbps).toBeNull();
    expect(scriptHardware(vi.mocked(execPowerShell).mock.calls[1][1])).toEqual(
      raw.hardware,
    );
    expect(samples.get(1)?.hardware?.Win32_Processor.at).toBe(1000);
    await collectPerformance({} as Client, "windows", 2, samples, ["cpu"]);
    expect(scriptHardware(vi.mocked(execPowerShell).mock.lastCall![1])).toEqual(
      {},
    );
    now.mockReturnValue(500);
    await collectPerformance({} as Client, "windows", 1, samples, ["cpu"]);
    expect(scriptHardware(vi.mocked(execPowerShell).mock.lastCall![1])).toEqual(
      {},
    );
  });

  it("refreshes at the bound, drops failed static refreshes, and retries while retaining partial live results", async () => {
    const samples: PerformanceSamples = new Map();
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const raw = JSON.parse(windows());
    raw.hardware = { Win32_Processor: raw.cpu.processors };
    vi.mocked(execPowerShell).mockResolvedValue({
      stdout: JSON.stringify(raw),
    } as any);
    await collectPerformance({} as Client, "windows", 1, samples, ["cpu"]);
    now.mockReturnValue(1000 + HARDWARE_REFRESH_MS);
    raw.hardware = {};
    raw.cpu.processors = [];
    raw.cpu.currentMHz = 2500;
    vi.mocked(execPowerShell).mockResolvedValue({
      stdout: JSON.stringify(raw),
      stderr: "partial CIM failure",
      code: 1,
    } as any);
    const partial = await collectPerformance(
      {} as Client,
      "windows",
      1,
      samples,
      ["cpu"],
    );
    expect(scriptHardware(vi.mocked(execPowerShell).mock.lastCall![1])).toEqual(
      {},
    );
    expect(partial.cpu).toMatchObject({
      model: null,
      currentGHz: 2.5,
      processes: 200,
    });
    expect(partial.perCore).toEqual([25, null]);
    expect(samples.get(1)?.hardware).toEqual({});
    raw.cpu.processors = JSON.parse(windows()).cpu.processors;
    raw.hardware = { Win32_Processor: raw.cpu.processors };
    vi.mocked(execPowerShell).mockResolvedValue({
      stdout: JSON.stringify(raw),
    } as any);
    expect(
      (await collectPerformance({} as Client, "windows", 1, samples, ["cpu"]))
        .cpu?.model,
    ).toBe("Fixture Ryzen");
    expect(scriptHardware(vi.mocked(execPowerShell).mock.lastCall![1])).toEqual(
      {},
    );
    expect(samples.get(1)?.hardware?.Win32_Processor.at).toBe(
      1000 + HARDWARE_REFRESH_MS,
    );
  });

  it("clears hardware with transport failures, host removal, and plugin shutdown", async () => {
    const state = createMetricsState();
    const raw = JSON.parse(windows());
    raw.hardware = { Win32_Processor: raw.cpu.processors };
    vi.mocked(execPowerShell).mockResolvedValue({
      stdout: JSON.stringify(raw),
    } as any);
    for (const id of [1, 2])
      await collectPerformance(
        {} as Client,
        "windows",
        id,
        state.rateSamples.performance,
        ["cpu"],
      );
    state.rateSamples.clear(1);
    expect(state.rateSamples.performance.has(1)).toBe(false);
    expect(state.rateSamples.performance.get(2)?.hardware).toBeDefined();
    vi.mocked(execPowerShell).mockRejectedValueOnce(new Error("SSH timeout"));
    expect(
      await collectPerformance(
        {} as Client,
        "windows",
        2,
        state.rateSamples.performance,
        ["cpu"],
      ),
    ).toEqual({});
    expect(state.rateSamples.performance.has(2)).toBe(false);
    await collectPerformance(
      {} as Client,
      "windows",
      2,
      state.rateSamples.performance,
      ["cpu"],
    );
    expect(scriptHardware(vi.mocked(execPowerShell).mock.lastCall![1])).toEqual(
      {},
    );
    state.rateSamples.clear();
    expect(state.rateSamples.performance.size).toBe(0);
  });

  it.skipIf(process.platform !== "win32")(
    "executes the Windows payload with static cache hits and fail-soft CIM misses",
    () => {
      const run = (
        hardware: Record<string, unknown[]> = {},
        fail = false,
        missingFrequency = false,
      ) => {
        const script = `
$calls = [Collections.Generic.List[string]]::new()
function Get-CimInstance($ClassName, $Filter) {
 $calls.Add($ClassName)
 switch ($ClassName) {
  'Win32_Processor' { if (${fail ? "$true" : "$false"}) { throw 'denied' }; [PSCustomObject]@{Name='Fixture CPU';MaxClockSpeed=4000;NumberOfCores=4} }
  'Win32_CacheMemory' { [PSCustomObject]@{Level=3;InstalledSize=64} }
  'Win32_PhysicalMemory' { [PSCustomObject]@{Capacity=8192;ConfiguredClockSpeed=3200} }
  'Win32_PhysicalMemoryArray' { [PSCustomObject]@{MemoryDevices=2} }
  'Win32_OperatingSystem' { [PSCustomObject]@{TotalVisibleMemorySize=7} }
  'Win32_PerfFormattedData_Counters_ProcessorInformation' { [PSCustomObject]@{Name='0,0';PercentProcessorTime=25;ProcessorFrequency=${missingFrequency ? "$null" : "2500"}} }
  'Win32_PerfFormattedData_PerfOS_System' { [PSCustomObject]@{Processes=42;Threads=100;SystemUpTime=300} }
  'Win32_PerfFormattedData_PerfOS_Memory' { [PSCustomObject]@{AvailableBytes=1024} }
  'Win32_DiskDrive' { [PSCustomObject]@{Index=0;Model='Fixture SSD';Size=100000;SerialNumber='fixture'} }
  'Win32_PerfFormattedData_PerfDisk_PhysicalDisk' { [PSCustomObject]@{Name='0 C:';PercentIdleTime=90;DiskReadBytesPersec=100} }
 }
}
function Get-PhysicalDisk { $calls.Add('PhysicalDisks'); [PSCustomObject]@{DeviceId=0;SerialNumber='fixture';MediaType=[IO.DriveType]::Fixed} }
function Get-Disk { $calls.Add('Disks'); [PSCustomObject]@{Number=0;BusType=[IO.DriveType]::Fixed;IsSystem=$true} }
function Get-Partition { $calls.Add('Partitions'); [PSCustomObject]@{DriveLetter='C'} }
function Get-Volume { [PSCustomObject]@{Size=90000} }
${buildPerformanceScript("windows", ["cpu", "memory", "disk"], hardware).replace("ConvertTo-Json -InputObject $r", "$r.calls = @($calls.ToArray()); ConvertTo-Json -InputObject $r")}`;
        const output = spawnSync(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", script],
          { encoding: "utf8", timeout: 10000 },
        );
        expect(output.error).toBeUndefined();
        expect(output.status, output.stderr).toBe(0);
        return JSON.parse(output.stdout);
      };
      const cold = run();
      expect(Object.keys(cold.hardware)).toHaveLength(8);
      expect(cold.hardware.Win32_Processor[0]).not.toHaveProperty(
        "CurrentClockSpeed",
      );
      const warm = run(cold.hardware);
      expect(cold.disks[0]).toMatchObject({ media: "Fixed", bus: "Fixed" });
      expect(warm.disks[0]).toMatchObject({ media: "Fixed", bus: "Fixed" });
      for (const name of Object.keys(cold.hardware))
        expect(warm.calls).not.toContain(name);
      for (const name of [
        "Win32_PerfFormattedData_Counters_ProcessorInformation",
        "Win32_PerfFormattedData_PerfOS_Memory",
        "Win32_PerfFormattedData_PerfDisk_PhysicalDisk",
        "Partitions",
      ])
        expect(warm.calls).toContain(name);
      expect(
        parsePerformance(JSON.stringify(warm), "windows").result.cpu,
      ).toMatchObject({ model: "Fixture CPU", currentGHz: 2.5 });
      const failed = run({}, true);
      expect(failed.hardware).not.toHaveProperty("Win32_Processor");
      expect(
        parsePerformance(JSON.stringify(failed), "windows").result.cpu,
      ).toMatchObject({ model: null, currentGHz: 2.5, processes: 42 });
      expect(failed.memory.modules).toHaveLength(1);
      const missing = run(cold.hardware, false, true);
      expect(missing.cpu.currentMHz).toBeNull();
      expect(
        parsePerformance(JSON.stringify(missing), "windows").result.cpu
          ?.currentGHz,
      ).toBeNull();
    },
    15000,
  );
});
