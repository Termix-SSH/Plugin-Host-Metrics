export interface SwapMetrics {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  /** null when the host has no configured swap. */
  percent: number | null;
}

/** Linux meminfo values are KiB. Missing or inconsistent readings are not zero usage. */
export function parseSwapMeminfo(text: string): SwapMetrics {
  const read = (key: string) => {
    const readings = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${key}:`));
    const match =
      readings.length === 1
        ? readings[0].match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB\\s*$`))
        : null;
    if (!match) throw new Error(`Missing or invalid ${key} reading`);
    const bytes = Number(match[1]) * 1024;
    if (!Number.isSafeInteger(bytes))
      throw new Error(`Invalid ${key} capacity`);
    return bytes;
  };
  const totalBytes = read("SwapTotal");
  const freeBytes = read("SwapFree");
  if (freeBytes > totalBytes) throw new Error("SwapFree exceeds SwapTotal");
  const usedBytes = totalBytes - freeBytes;
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    percent: totalBytes === 0 ? null : (usedBytes / totalBytes) * 100,
  };
}
