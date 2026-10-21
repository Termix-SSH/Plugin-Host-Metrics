import type { ServerMetrics } from "../shared/metrics.js";

type Proc = NonNullable<NonNullable<ServerMetrics["processes"]>["top"]>[number];
export type ProcSort = "cpu" | "mem" | "pid";
export interface ProcRow {
  proc: Proc;
  depth: number;
}

const key = (p: Proc, by: ProcSort) =>
  by === "pid" ? -Number(p.pid) : Number(by === "cpu" ? p.cpu : p.mem) || 0;

/** Filters by name or pid, then sorts; tree mode nests children under their parent like htop's F5. */
export function viewProcesses(
  all: Proc[],
  by: ProcSort,
  filter: string,
  tree: boolean,
): ProcRow[] {
  const q = filter.trim().toLowerCase();
  const sorted = [...all].sort((a, b) => key(b, by) - key(a, by));
  if (!tree) {
    return sorted
      .filter((p) => !q || p.command.toLowerCase().includes(q) || p.pid === q)
      .map((proc) => ({ proc, depth: 0 }));
  }
  const pids = new Set(all.map((p) => p.pid));
  const kids = new Map<string, Proc[]>();
  for (const p of sorted) {
    // A parent outside the list (only the top 60 are sent) makes this a root.
    const parent = p.ppid && pids.has(p.ppid) && p.ppid !== p.pid ? p.ppid : "";
    kids.set(parent, [...(kids.get(parent) ?? []), p]);
  }
  const out: ProcRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string, depth: number) => {
    for (const proc of kids.get(parent) ?? []) {
      if (seen.has(proc.pid)) continue;
      seen.add(proc.pid);
      out.push({ proc, depth });
      walk(proc.pid, depth + 1);
    }
  };
  walk("", 0);
  // A parent loop (pid reuse between two samples) leaves no root; show those flat.
  for (const p of sorted) {
    if (seen.has(p.pid)) continue;
    seen.add(p.pid);
    out.push({ proc: p, depth: 0 });
    walk(p.pid, 1);
  }
  // Filtering a tree keeps the matches only, so the indent still shows the nesting.
  return q
    ? out.filter(
        ({ proc }) => proc.command.toLowerCase().includes(q) || proc.pid === q,
      )
    : out;
}

/** Bar colour by load, like htop's meters. */
export const loadColor = (pct: number | null) =>
  pct == null || pct < 50
    ? "bg-emerald-500"
    : pct < 80
      ? "bg-amber-500"
      : "bg-red-500";

/** Same thresholds as loadColor, as a text colour for the gauge arc. */
export const loadTextColor = (pct: number | null) =>
  pct == null || pct < 50
    ? "text-emerald-500"
    : pct < 80
      ? "text-amber-500"
      : "text-red-500";
