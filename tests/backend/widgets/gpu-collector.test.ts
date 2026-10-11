import { describe, expect, it } from "vitest";
import {
  parseNvidiaSmiGpus,
  parseNvidiaSmiOutput,
  parseNvidiaSmiProcesses,
  parseAmdgpuOutput,
  mergeGpuMetrics,
} from "../../../src/backend/widgets/gpu-collector.js";

const RTX_UUID = "GPU-3b8f2c1a-5d4e-7f60-8a9b-0c1d2e3f4a5b";
const H100_UUID = "GPU-9a8b7c6d-5e4f-3a2b-1c0d-e9f8a7b6c5d4";

// index, uuid, driver_version, utilization.gpu, memory.used, memory.total,
// temperature.gpu, power.draw, power.limit, fan.speed, name
const GPU_QUERY_OUTPUT = [
  `0, ${RTX_UUID}, 550.54.14, 37, 8123, 24564, 61, 182.47, 450.00, 45, NVIDIA GeForce RTX 4090`,
  `1, ${H100_UUID}, 550.54.14, 0, 1, 81559, 34, 62.10, 700.00, [N/A], NVIDIA H100 80GB HBM3`,
  "",
].join("\n");

// gpu_uuid, pid, used_memory, process_name
const APPS_QUERY_OUTPUT = [
  `${RTX_UUID}, 12345, 7890, /usr/bin/python3`,
  `${H100_UUID}, 23456, [N/A], /opt/app/worker, gpu, v2`,
  "",
].join("\n");

const DRIVER_FAILURE =
  "NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver. Make sure that the latest NVIDIA driver is installed and running.\n";

const RTX = {
  index: 0,
  uuid: RTX_UUID,
  name: "NVIDIA GeForce RTX 4090",
  driverVersion: "550.54.14",
  utilizationPercent: 37,
  memoryUsedMiB: 8123,
  memoryTotalMiB: 24564,
  memoryPercent: 33.1,
  temperatureCelsius: 61,
  powerDrawWatts: 182.5,
  powerLimitWatts: 450,
  fanPercent: 45,
};

const H100 = {
  index: 1,
  uuid: H100_UUID,
  name: "NVIDIA H100 80GB HBM3",
  driverVersion: "550.54.14",
  utilizationPercent: 0,
  memoryUsedMiB: 1,
  memoryTotalMiB: 81559,
  memoryPercent: 0,
  temperatureCelsius: 34,
  powerDrawWatts: 62.1,
  powerLimitWatts: 700,
  fanPercent: null,
};

describe("gpu collector", () => {
  describe("parseNvidiaSmiGpus", () => {
    it("parses one device per row of --query-gpu output", () => {
      expect(parseNvidiaSmiGpus(GPU_QUERY_OUTPUT)).toEqual([RTX, H100]);
    });

    it("maps unsupported and unavailable readings to null", () => {
      const [gpu] = parseNvidiaSmiGpus(
        "0, GPU-aaaa, 470.182.03, [N/A], 512, [N/A], [Not Supported], [Not Supported], [N/A], [Unknown Error], Tesla K80\n",
      );

      expect(gpu).toEqual({
        index: 0,
        uuid: "GPU-aaaa",
        name: "Tesla K80",
        driverVersion: "470.182.03",
        utilizationPercent: null,
        memoryUsedMiB: 512,
        memoryTotalMiB: null,
        memoryPercent: null,
        temperatureCelsius: null,
        powerDrawWatts: null,
        powerLimitWatts: null,
        fanPercent: null,
      });
    });

    it("keeps a device name that contains commas intact", () => {
      const [gpu] = parseNvidiaSmiGpus(
        "0, GPU-bbbb, 535.0, 5, 10, 100, 40, 20, 70, 30, Quadro RTX, Mobile, Max-Q\n",
      );

      expect(gpu.name).toBe("Quadro RTX, Mobile, Max-Q");
      expect(gpu.fanPercent).toBe(30);
    });

    it("ignores driver error text printed to stdout", () => {
      expect(parseNvidiaSmiGpus(DRIVER_FAILURE)).toEqual([]);
      expect(parseNvidiaSmiGpus("No devices were found\n")).toEqual([]);
    });

    it("skips a csv header row", () => {
      const header =
        "index, uuid, driver_version, utilization.gpu [%], memory.used [MiB], memory.total [MiB], temperature.gpu, power.draw [W], power.limit [W], fan.speed [%], name\n";

      expect(parseNvidiaSmiGpus(header + GPU_QUERY_OUTPUT)).toEqual([
        RTX,
        H100,
      ]);
    });
  });

  describe("parseNvidiaSmiProcesses", () => {
    it("attaches each process to the GPU with the matching uuid", () => {
      expect(parseNvidiaSmiProcesses(APPS_QUERY_OUTPUT, [RTX, H100])).toEqual([
        {
          gpuIndex: 0,
          pid: 12345,
          name: "/usr/bin/python3",
          memoryUsedMiB: 7890,
        },
        {
          gpuIndex: 1,
          pid: 23456,
          name: "/opt/app/worker, gpu, v2",
          memoryUsedMiB: null,
        },
      ]);
    });

    it("keeps processes whose uuid matches no listed GPU", () => {
      expect(
        parseNvidiaSmiProcesses("GPU-unknown, 77, 100, /bin/app\n", [RTX]),
      ).toEqual([
        { gpuIndex: null, pid: 77, name: "/bin/app", memoryUsedMiB: 100 },
      ]);
    });

    it("ignores driver error text printed to stdout", () => {
      expect(parseNvidiaSmiProcesses(DRIVER_FAILURE, [RTX])).toEqual([]);
    });

    it("skips a csv header row", () => {
      expect(
        parseNvidiaSmiProcesses(
          "gpu_uuid, pid, used_gpu_memory [MiB], process_name\n",
          [RTX],
        ),
      ).toEqual([]);
    });
  });

  describe("parseNvidiaSmiOutput", () => {
    it("splits the combined command output into devices and processes", () => {
      const result = parseNvidiaSmiOutput(
        `${GPU_QUERY_OUTPUT}---\n${APPS_QUERY_OUTPUT}`,
      );

      expect(result.source).toBe("nvidia-smi");
      expect(result.gpus).toEqual([RTX, H100]);
      expect(result.processes.map((p) => [p.gpuIndex, p.pid])).toEqual([
        [0, 12345],
        [1, 23456],
      ]);
    });

    it("reports no source when nvidia-smi is not installed", () => {
      expect(parseNvidiaSmiOutput("")).toEqual({
        source: "none",
        gpus: [],
        processes: [],
      });
    });

    it("reports no source when the driver cannot be reached", () => {
      expect(
        parseNvidiaSmiOutput(`${DRIVER_FAILURE}---\n${DRIVER_FAILURE}`),
      ).toEqual({ source: "none", gpus: [], processes: [] });
    });
  });
});

// Values from a Radeon RX 7900 XTX in issue #1, plus an RX 6800 with no lspci.
const AMDGPU_OUTPUT = [
  "card=card1",
  "pci=0000:03:00.0",
  'lspci=03:00.0 "VGA compatible controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 31 [Radeon RX 7900 XT/7900 XTX/7900M]" -rc8 "Sapphire" "Device 471e"',
  "gpu_busy_percent=1",
  "mem_info_vram_used=2474868736",
  "mem_info_vram_total=25753026560",
  "temp1_input=44000",
  "power1_average=74000000",
  "power1_input=",
  "power1_cap=327000000",
  "fan1_input=547",
  "pwm1=38",
  "pwm1_max=255",
  "card=card2",
  "pci=0000:0b:00.0",
  "lspci=",
  "gpu_busy_percent=",
  "mem_info_vram_used=0",
  "mem_info_vram_total=17163091968",
  "",
].join("\n");

describe("amdgpu collector", () => {
  it("reads sysfs values into gpu devices", () => {
    const [xtx, rx6800] = parseAmdgpuOutput(AMDGPU_OUTPUT);
    expect(xtx).toEqual({
      index: 0,
      uuid: "0000:03:00.0",
      name: "AMD Radeon RX 7900 XT/7900 XTX/7900M",
      driverVersion: null,
      utilizationPercent: 1,
      memoryUsedMiB: 2360,
      memoryTotalMiB: 24560,
      memoryPercent: 9.6,
      temperatureCelsius: 44,
      powerDrawWatts: 74,
      powerLimitWatts: 327,
      fanPercent: 15,
    });
    expect(rx6800).toMatchObject({
      index: 1,
      name: "AMD GPU 0000:0b:00.0",
      utilizationPercent: null,
      memoryUsedMiB: 0,
      memoryPercent: 0,
      temperatureCelsius: null,
      powerDrawWatts: null,
      fanPercent: null,
    });
  });

  it("falls back to power1_input and keeps a zero fan", () => {
    const [gpu] = parseAmdgpuOutput(
      "card=card0\npci=x\npower1_average=\npower1_input=5500000\npwm1=0\n",
    );
    expect(gpu.powerDrawWatts).toBe(5.5);
    expect(gpu.fanPercent).toBe(0);
  });

  it("returns nothing without AMD cards", () => {
    expect(parseAmdgpuOutput("")).toEqual([]);
  });

  it("adds AMD cards after NVIDIA ones", () => {
    const nvidia = parseNvidiaSmiOutput(
      `${GPU_QUERY_OUTPUT}---\n${APPS_QUERY_OUTPUT}`,
    );
    const merged = mergeGpuMetrics(nvidia, AMDGPU_OUTPUT);
    expect(merged.source).toBe("nvidia-smi");
    expect(merged.gpus.map((gpu) => gpu.index)).toEqual([0, 1, 2, 3]);
    expect(merged.processes).toEqual(nvidia.processes);

    const amdOnly = mergeGpuMetrics(
      { source: "none", gpus: [], processes: [] },
      AMDGPU_OUTPUT,
    );
    expect(amdOnly.source).toBe("amdgpu");
    expect(amdOnly.gpus).toHaveLength(2);
  });
});
