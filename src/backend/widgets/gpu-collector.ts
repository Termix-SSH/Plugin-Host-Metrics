import { execCommand } from "@termix-ssh/plugin-sdk/host-commands";
import { toFixedNum } from "../util.js";
import type { Client } from "ssh2";

export interface GpuDevice {
  index: number;
  uuid: string;
  name: string;
  driverVersion: string | null;
  utilizationPercent: number | null;
  memoryUsedMiB: number | null;
  memoryTotalMiB: number | null;
  memoryPercent: number | null;
  temperatureCelsius: number | null;
  powerDrawWatts: number | null;
  powerLimitWatts: number | null;
  fanPercent: number | null;
}

export interface GpuProcess {
  /** Null when nvidia-smi reports a uuid that matches none of the listed GPUs. */
  gpuIndex: number | null;
  pid: number;
  name: string;
  memoryUsedMiB: number | null;
}

export interface GpuMetrics {
  source: "nvidia-smi" | "amdgpu" | "none";
  gpus: GpuDevice[];
  processes: GpuProcess[];
}

const SECTION_SEPARATOR = "---";

// The free-text name is queried last so commas inside it cannot shift the
// numeric columns; the parsers rejoin everything past the fixed fields.
const GPU_QUERY_FIELDS = [
  "index",
  "uuid",
  "driver_version",
  "utilization.gpu",
  "memory.used",
  "memory.total",
  "temperature.gpu",
  "power.draw",
  "power.limit",
  "fan.speed",
  "name",
];
const APPS_QUERY_FIELDS = ["gpu_uuid", "pid", "used_memory", "process_name"];

const NVIDIA_SMI_COMMAND = [
  "command -v nvidia-smi >/dev/null 2>&1 || exit 0;",
  `nvidia-smi --query-gpu=${GPU_QUERY_FIELDS.join(",")} --format=csv,noheader,nounits 2>/dev/null;`,
  `echo ${SECTION_SEPARATOR};`,
  `nvidia-smi --query-compute-apps=${APPS_QUERY_FIELDS.join(",")} --format=csv,noheader,nounits 2>/dev/null`,
].join(" ");

const NO_GPU: GpuMetrics = { source: "none", gpus: [], processes: [] };

/** Reads a numeric field; nvidia-smi writes "[N/A]", "[Not Supported]" etc. for missing ones. */
function parseReading(raw: string | undefined, digits = 1): number | null {
  const value = raw?.trim();
  if (!value || value.startsWith("[")) return null;
  return toFixedNum(Number(value), digits);
}

function parseInteger(raw: string | undefined): number | null {
  const value = raw?.trim();
  return value && /^\d+$/.test(value) ? Number(value) : null;
}

function splitCsvRow(line: string, fixedFields: number): string[] | null {
  const parts = line.split(",").map((part) => part.trim());
  if (parts.length <= fixedFields) return null;
  return [...parts.slice(0, fixedFields), parts.slice(fixedFields).join(", ")];
}

export function parseNvidiaSmiGpus(output: string): GpuDevice[] {
  const fixedFields = GPU_QUERY_FIELDS.length - 1;
  const gpus: GpuDevice[] = [];

  for (const line of output.split("\n")) {
    const row = splitCsvRow(line, fixedFields);
    if (!row) continue;

    const [
      rawIndex,
      uuid,
      driverVersion,
      utilization,
      memoryUsed,
      memoryTotal,
      temperature,
      powerDraw,
      powerLimit,
      fan,
      name,
    ] = row;
    const index = parseInteger(rawIndex);
    if (index === null || !uuid) continue;

    const memoryUsedMiB = parseReading(memoryUsed, 0);
    const memoryTotalMiB = parseReading(memoryTotal, 0);

    gpus.push({
      index,
      uuid,
      name,
      driverVersion:
        driverVersion && !driverVersion.startsWith("[") ? driverVersion : null,
      utilizationPercent: parseReading(utilization),
      memoryUsedMiB,
      memoryTotalMiB,
      memoryPercent:
        memoryUsedMiB !== null &&
        memoryTotalMiB !== null &&
        memoryTotalMiB !== 0
          ? toFixedNum((memoryUsedMiB / memoryTotalMiB) * 100, 1)
          : null,
      temperatureCelsius: parseReading(temperature),
      powerDrawWatts: parseReading(powerDraw),
      powerLimitWatts: parseReading(powerLimit),
      fanPercent: parseReading(fan),
    });
  }

  return gpus;
}

export function parseNvidiaSmiProcesses(
  output: string,
  gpus: GpuDevice[],
): GpuProcess[] {
  const indexByUuid = new Map(gpus.map((gpu) => [gpu.uuid, gpu.index]));
  const processes: GpuProcess[] = [];

  for (const line of output.split("\n")) {
    const row = splitCsvRow(line, APPS_QUERY_FIELDS.length - 1);
    if (!row) continue;

    const [uuid, rawPid, memoryUsed, name] = row;
    const pid = parseInteger(rawPid);
    if (pid === null) continue;

    processes.push({
      gpuIndex: indexByUuid.get(uuid) ?? null,
      pid,
      name,
      memoryUsedMiB: parseReading(memoryUsed, 0),
    });
  }

  return processes;
}

export function parseNvidiaSmiOutput(stdout: string): GpuMetrics {
  const lines = stdout.split("\n");
  const separator = lines.findIndex(
    (line) => line.trim() === SECTION_SEPARATOR,
  );
  const gpuSection =
    separator === -1 ? stdout : lines.slice(0, separator).join("\n");
  const appsSection =
    separator === -1 ? "" : lines.slice(separator + 1).join("\n");

  const gpus = parseNvidiaSmiGpus(gpuSection);
  if (gpus.length === 0) return NO_GPU;

  return {
    source: "nvidia-smi",
    gpus,
    processes: parseNvidiaSmiProcesses(appsSection, gpus),
  };
}

// amdgpu exposes everything in sysfs, readable without root. Prints one
// key=value block per AMD card, each starting with `card=`.
const AMDGPU_COMMAND = [
  "for d in /sys/class/drm/card[0-9]*; do",
  'case "${d##*/}" in *-*) continue ;; esac;',
  'dev="$d/device";',
  '[ "$(cat "$dev/vendor" 2>/dev/null)" = "0x1002" ] || continue;',
  'pci=$(basename "$(readlink -f "$dev")");',
  'echo "card=${d##*/}"; echo "pci=$pci";',
  'echo "lspci=$(lspci -mm -s "$pci" 2>/dev/null | head -n1)";',
  "for f in gpu_busy_percent mem_info_vram_used mem_info_vram_total; do",
  'echo "$f=$(cat "$dev/$f" 2>/dev/null)"; done;',
  'h=$(ls -d "$dev"/hwmon/hwmon* 2>/dev/null | head -n1);',
  'if [ -n "$h" ]; then',
  "for f in temp1_input power1_average power1_input power1_cap fan1_input pwm1 pwm1_max; do",
  'echo "$f=$(cat "$h/$f" 2>/dev/null)"; done; fi;',
  "done",
].join(" ");

function readNumber(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value || !/^-?\d+(\.\d+)?$/.test(value)) return null;
  return Number(value);
}

/** Pulls the model out of `lspci -mm`, e.g. "Radeon RX 7900 XT/7900 XTX". */
function amdName(lspci: string | undefined, pci: string): string {
  const fields = [...(lspci ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const device = fields[2]?.trim();
  if (!device) return `AMD GPU ${pci}`.trim();
  const bracket = /\[([^\]]+)\]/.exec(device)?.[1];
  return `AMD ${bracket ?? device}`;
}

export function parseAmdgpuOutput(stdout: string, firstIndex = 0): GpuDevice[] {
  const blocks: Array<Record<string, string>> = [];
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "card") blocks.push({});
    const block = blocks[blocks.length - 1];
    if (block) block[key] = value;
  }

  return blocks.map((block, i) => {
    const toMiB = (raw: string | undefined) => {
      const bytes = readNumber(raw);
      return bytes === null ? null : Math.round(bytes / 1024 / 1024);
    };
    const toWatts = (raw: string | undefined) => {
      const micro = readNumber(raw);
      return micro === null ? null : toFixedNum(micro / 1_000_000, 1);
    };
    const memoryUsedMiB = toMiB(block.mem_info_vram_used);
    const memoryTotalMiB = toMiB(block.mem_info_vram_total);
    const temp = readNumber(block.temp1_input);
    const pwm = readNumber(block.pwm1);
    const pwmMax = readNumber(block.pwm1_max) || 255;
    const pci = block.pci || block.card || "";

    return {
      index: firstIndex + i,
      uuid: pci,
      name: amdName(block.lspci, pci),
      driverVersion: null,
      utilizationPercent: readNumber(block.gpu_busy_percent),
      memoryUsedMiB,
      memoryTotalMiB,
      memoryPercent:
        memoryUsedMiB !== null && memoryTotalMiB
          ? toFixedNum((memoryUsedMiB / memoryTotalMiB) * 100, 1)
          : null,
      temperatureCelsius: temp === null ? null : toFixedNum(temp / 1000, 1),
      powerDrawWatts:
        toWatts(block.power1_average) ?? toWatts(block.power1_input),
      powerLimitWatts: toWatts(block.power1_cap),
      fanPercent: pwm === null ? null : toFixedNum((pwm / pwmMax) * 100, 0),
    };
  });
}

/** NVIDIA and AMD cards together, so mixed hosts report every GPU. */
export function mergeGpuMetrics(
  nvidia: GpuMetrics,
  amdStdout: string,
): GpuMetrics {
  const firstIndex = nvidia.gpus.reduce(
    (max, gpu) => Math.max(max, gpu.index + 1),
    0,
  );
  const amd = parseAmdgpuOutput(amdStdout, firstIndex);
  if (amd.length === 0) return nvidia;
  return {
    source: nvidia.gpus.length > 0 ? nvidia.source : "amdgpu",
    gpus: [...nvidia.gpus, ...amd],
    processes: nvidia.processes,
  };
}

export async function collectGpuMetrics(client: Client): Promise<GpuMetrics> {
  let nvidia = NO_GPU;
  try {
    // nvidia-smi can take a few seconds on hosts without persistence mode.
    const result = await execCommand(client, NVIDIA_SMI_COMMAND, 15000);
    nvidia = parseNvidiaSmiOutput(result.stdout);
  } catch {
    // expected when the host has no NVIDIA driver or the query times out
  }
  try {
    const result = await execCommand(client, AMDGPU_COMMAND, 10000);
    return mergeGpuMetrics(nvidia, result.stdout);
  } catch {
    return nvidia;
  }
}
