import type { ReactNode } from "react";
import { SmoothLineChart as LineChart } from "./SmoothCharts";
import { loadColor, loadTextColor } from "../process-view";

export interface LiveStat {
  caption: string;
  value: string;
}

/** Chart tops that split into round ticks (the chart draws five). */
const TOPS = [4, 8, 12, 20, 40, 60, 80, 100];

/** The top of a live chart: the first round value with room above the data. */
export function liveDomain(values: Array<number | null>): [number, number] {
  const top = Math.max(
    0,
    ...values.filter((value): value is number => value != null),
  );
  return [0, TOPS.find((value) => value >= top * 1.2) ?? 100];
}

/**
 * The live view a usage card opens on: the number first, where it is always
 * visible, a bar for where it sits out of 100, a few stats, and a line of the
 * last minute or so. The chart scales to the data so small changes show.
 */
export function LiveUsage({
  percent,
  caption,
  stats,
  label,
  color,
  points,
  timestamps,
  chartHeight,
  children,
}: {
  percent: number | null;
  /** Under the number, like "12 cores". */
  caption?: string;
  stats: LiveStat[];
  /** The chart's series name. */
  label: string;
  color: string;
  points: Array<number | null>;
  timestamps: string[];
  chartHeight: number;
  /** Details under the chart. */
  children?: ReactNode;
}) {
  const value = percent == null ? null : Math.min(100, Math.max(0, percent));
  const enough = points.filter((point) => point != null).length >= 2;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-x-5 gap-y-2">
        <div className="flex min-w-16 flex-col">
          <span
            className={`font-mono text-3xl leading-none font-semibold tabular-nums ${loadTextColor(value)}`}
          >
            {value == null ? "-" : `${value.toFixed(0)}%`}
          </span>
          {caption && (
            <span className="mt-1 text-[10px] tracking-widest text-muted-foreground uppercase">
              {caption}
            </span>
          )}
        </div>
        {stats.map((stat) => (
          <div key={stat.caption} className="flex min-w-0 flex-col">
            <span className="text-[10px] tracking-widest text-muted-foreground uppercase">
              {stat.caption}
            </span>
            <span className="truncate font-mono text-xs font-semibold tabular-nums">
              {stat.value}
            </span>
          </div>
        ))}
      </div>
      <div className="h-1 w-full bg-muted">
        <div
          className={`h-full transition-[width] duration-700 ease-out motion-reduce:transition-none ${loadColor(value)}`}
          style={{ width: `${value ?? 0}%` }}
        />
      </div>
      {enough ? (
        <LineChart
          series={[{ key: "live", label, color, data: points }]}
          timestamps={timestamps}
          domain={liveDomain(points)}
          yFormatter={(v) => `${v.toFixed(0)}%`}
          height={chartHeight}
        />
      ) : (
        <div
          className="flex items-center justify-center text-[11px] text-muted-foreground"
          style={{ height: chartHeight }}
        />
      )}
      {children}
    </div>
  );
}
