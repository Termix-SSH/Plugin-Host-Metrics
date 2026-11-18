// QNAP QuTS hero puts arcstats under /proc/lpl or /proc/sys instead of /proc/spl.
export const ARC_STATS_FILES = [
  "/proc/spl/kstat/zfs/arcstats",
  "/proc/lpl/kstat/zfs/arcstats",
  "/proc/sys/kstat/zfs/misc/arcstats",
];

export const ARC_MARKER = "@@ARC";

export const ARC_SCRIPT = `for f in ${ARC_STATS_FILES.join(" ")}; do if [ -r "$f" ]; then printf '\\n${ARC_MARKER}\\n'; cat "$f"; break; fi; done`;

/**
 * Bytes of ZFS ARC the kernel can give back, which /proc/meminfo counts as used.
 * Same as htop: size above c_min.
 */
export function parseArcReclaimableBytes(text: string): number | null {
  let size: number | null = null;
  let min: number | null = null;
  for (const line of text.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p.length !== 3 || !/^\d+$/.test(p[2])) continue;
    if (p[0] === "size") size = Number(p[2]);
    else if (p[0] === "c_min") min = Number(p[2]);
  }
  if (size == null) return null;
  return Math.max(0, size - (min ?? 0));
}

/** Splits output that may end with an ARC section. */
export function splitArc(stdout: string): { rest: string; arcBytes: number } {
  const at = stdout.indexOf(`\n${ARC_MARKER}\n`);
  if (at < 0) return { rest: stdout, arcBytes: 0 };
  return {
    rest: stdout.slice(0, at),
    arcBytes:
      parseArcReclaimableBytes(stdout.slice(at + ARC_MARKER.length + 2)) ?? 0,
  };
}
