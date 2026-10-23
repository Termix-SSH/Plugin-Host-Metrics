import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Sparkline, LineChart } from "@termix-ssh/plugin-sdk/ui";

type Row = Array<number | null | undefined>;
type Last = Array<number | null>;

const ease = (t: number) => 1 - (1 - t) ** 3;

// All charts share one frame request, including hosts with many logical cores.
const pending = new Set<() => void>();
let frame: number | undefined;
let lastFrame = 0;
function flush(now: number) {
  if (now - lastFrame < 1000 / 30) {
    frame = requestAnimationFrame(flush);
    return;
  }
  lastFrame = now;
  frame = undefined;
  const callbacks = [...pending];
  pending.clear();
  callbacks.forEach((callback) => callback());
}
function schedule(callback: () => void) {
  pending.add(callback);
  frame ??= requestAnimationFrame(flush);
  return () => {
    pending.delete(callback);
    if (!pending.size && frame !== undefined) {
      cancelAnimationFrame(frame);
      frame = undefined;
    }
  };
}

/** Moves each row's newest point from its previously shown value to its new one. */
export function tweenLast(rows: Row[], from: Last, progress: number): Row[] {
  if (progress >= 1) return rows;
  return rows.map((row, i) => {
    const to = row[row.length - 1];
    const start = from[i];
    if (to == null || start == null) return row;
    const out = row.slice();
    out[row.length - 1] = start + (to - start) * ease(progress);
    return out;
  });
}

/**
 * The SDK charts redraw instantly, so the newest point glides in from the last
 * one instead. Frames are capped near 30 fps so many charts stay cheap.
 */
export function useSmoothSeries(rows: Row[], durationMs = 800): Row[] {
  const signature = JSON.stringify(rows);
  const [out, setOut] = useState(rows);
  const shown = useRef(rows);
  useEffect(() => {
    const target = JSON.parse(signature) as Row[];
    const from = shown.current.map((row) => row[row.length - 1] ?? null);
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const start = performance.now();
    const moving = target.some((row, i) => {
      const value = row[row.length - 1];
      return value != null && from[i] != null && value !== from[i];
    });
    let cancel = () => {};
    const update = () => {
      const progress =
        !moving || media?.matches || durationMs <= 0
          ? 1
          : Math.min(1, (performance.now() - start) / durationMs);
      shown.current = tweenLast(target, from, progress);
      setOut(shown.current);
      if (progress < 1) cancel = schedule(update);
    };
    const motionChanged = () => {
      cancel();
      update();
    };
    update();
    media?.addEventListener("change", motionChanged);
    return () => {
      cancel();
      media?.removeEventListener("change", motionChanged);
    };
  }, [signature, durationMs]);
  return out;
}

export function SmoothSparkline(props: ComponentProps<typeof Sparkline>) {
  const [data] = useSmoothSeries([props.data]);
  return <Sparkline {...props} data={data} />;
}

export function SmoothLineChart(props: ComponentProps<typeof LineChart>) {
  const data = useSmoothSeries(props.series.map((series) => series.data));
  return (
    <LineChart
      {...props}
      series={props.series.map((series, i) => ({
        ...series,
        data: data[i] ?? series.data,
      }))}
    />
  );
}
