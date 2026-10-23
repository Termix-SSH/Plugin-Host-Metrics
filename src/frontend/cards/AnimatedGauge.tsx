import { useEffect, useState } from "react";

const SIZE = 120;
const STROKE = 9;
const R = (SIZE - STROKE) / 2;
const CIRC = 2 * Math.PI * R;
const TRACK = CIRC * 0.75;

const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * RadialGauge look-alike whose arc always eases to the new value. The
 * transition is inline so host CSS cannot drop it, and it starts from 0 on
 * mount so the first reading sweeps in too.
 */
export function AnimatedGauge({
  value,
  caption,
  colorClassName,
  durationMs = 1500,
}: {
  value: number | null;
  caption?: string;
  colorClassName: string;
  durationMs?: number;
}) {
  const pct = value === null ? 0 : Math.min(100, Math.max(0, value));
  const [shown, setShown] = useState(() => (reducedMotion() ? pct : 0));
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(pct));
    return () => cancelAnimationFrame(id);
  }, [pct]);
  return (
    <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className={colorClassName}
        style={{ transform: "rotate(135deg)" }}
        aria-hidden="true"
      >
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          strokeWidth={STROKE}
          className="stroke-muted"
          strokeDasharray={`${TRACK} ${CIRC}`}
          strokeLinecap="round"
        />
        <circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeDasharray={`${TRACK * (shown / 100)} ${CIRC}`}
          strokeLinecap="round"
          style={{
            transition: reducedMotion()
              ? "none"
              : `stroke-dasharray ${durationMs}ms cubic-bezier(0.22, 1, 0.36, 1)`,
          }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={`text-xl font-bold leading-none md:text-2xl ${value === null ? "text-muted-foreground" : colorClassName}`}
        >
          {value === null ? "N/A" : `${Math.round(pct)}%`}
        </span>
        {caption && (
          <span className="mt-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {caption}
          </span>
        )}
      </div>
    </div>
  );
}
