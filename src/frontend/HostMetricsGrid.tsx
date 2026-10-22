import { Settings2 } from "lucide-react";
import { CardSettingsView } from "./card-settings";
import { packGrid } from "./grid-packing";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type DragEvent,
} from "react";
import {
  CardGridCanvas,
  Button,
  type GridCardCatalogEntry,
} from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import {
  MAX_CARD_WIDTH,
  MIN_CARD_WIDTH,
  type HostMetricsLayout,
} from "../shared/host-metrics.js";

// Coarser tracks keep CSS dense auto-placement cheap; 1px tracks froze reorders.
// shortcut: heights land on a 4px lattice (columns stay 1px), drop UNIT to 1 if exact pixels matter.
const UNIT = 4;
const trackCount = (total: number) => Math.max(1, Math.ceil(total));
const rowSpan = (height: number, gap: number) =>
  Math.max(1, Math.ceil((height + gap) / UNIT));

// Keep the SDK chrome and dense packing, replacing only its coarse tracks and resize handles.
const sizedCardStyles = `
.hm-card-grid { position: relative; --hm-gap: calc(12rem / 14); }
.hm-card-grid [data-hm-grid] {
  width: calc(100% + var(--hm-gap));
  grid-template-columns: repeat(var(--hm-tracks, 1), minmax(0, 1fr)) !important;
  grid-auto-rows: ${UNIT}px !important;
  gap: 0 !important;
}
.hm-card-grid [data-hm-tile] {
  margin-right: var(--hm-gap); margin-bottom: var(--hm-gap);
  grid-column: span var(--hm-cols, 1) !important; grid-row: span var(--hm-rows, 1) !important;
}
.hm-card-grid [data-hm-tile] > .cursor-row-resize { display: none; }
/* shortcut: SDK 1.0.19 lacks chrome options, replace this override when the SDK exposes them. */
.hm-card-grid [data-hm-tile] > .absolute.top-2.right-2 > div + button:not(:last-child) { display: none; }
.hm-card-grid[data-edit-mode="true"] .hm-card-content { padding-top: 2.5rem !important; box-sizing: border-box; }
.hm-card-settings { position: absolute; top: 0.5rem; right: 4.5rem; z-index: 30; }
.hm-snap-guide { position: absolute; z-index: 45; pointer-events: none; background: var(--accent-brand, #60a5fa); box-shadow: 0 0 6px var(--accent-brand, #60a5fa); }
.hm-snap-guide[data-axis="x"] { width: 2px; margin-left: -1px; }
.hm-snap-guide[data-axis="y"] { height: 2px; margin-top: -1px; }
.hm-left-handle { left: 0; right: auto; }
.hm-sized-card[data-hm-resizing="true"]::after {
  content: ""; position: absolute; inset: 0; z-index: 40; pointer-events: none;
  outline: 2px solid var(--accent-brand, #60a5fa); outline-offset: -2px;
}
[data-hm-resize-preview], [data-hm-drop-preview] {
  position: absolute; z-index: 35; pointer-events: none; box-sizing: border-box;
  background: rgba(128, 128, 128, 0.3); border: 2px solid rgba(160, 160, 160, 0.9);
}
.hm-resize-handle { position: absolute; z-index: 30; display: flex; touch-action: none; }
.hm-width-handle { top: 2.5rem; bottom: 1rem; right: 0; width: 0.75rem; cursor: ew-resize; align-items: center; justify-content: center; }
.hm-height-handle { bottom: 0; left: 0; right: 1rem; height: 0.75rem; cursor: ns-resize; align-items: center; justify-content: center; }
.hm-corner-handle { bottom: 0; right: 0; width: 1rem; height: 1rem; cursor: nwse-resize; align-items: center; justify-content: center; }
.hm-corner-handle::after { content: ""; width: 0.5rem; height: 0.5rem; border-right: 2px solid var(--border); border-bottom: 2px solid var(--border); }
.hm-resize-handle:focus-visible { outline: 2px solid var(--accent-brand, #60a5fa); }
@media (max-width: 767px) { .hm-resize-handle { display: none; } }
.hm-sized-card[data-fixed-height="true"] > .hm-card-content > div { height: 100%; }
.hm-sized-card[data-fixed-height="true"] > .hm-card-content > div > div:last-child {
  max-height: none !important;
  overflow: auto;
}
.hm-sized-card[data-fixed-height="true"] [data-host-metrics-log] {
  max-height: none;
  min-height: 0;
  flex: 1 1 0%;
}
.hm-sized-card[data-fixed-height="true"] > .hm-card-content > div > div:last-child:has(> [data-host-metrics-log]) {
  display: flex;
  flex-direction: column;
}
.hm-sized-card[data-fixed-height="true"] > .hm-card-content > div > div:last-child:has(> [data-host-metrics-log]) > :not([data-host-metrics-log]) {
  flex-shrink: 0;
}
`;

type Slot = HostMetricsLayout["slots"][number];
// SDK 1.0.19 stores height in 14px-root units, whereas explicit width is in CSS pixels.
const remScale = () =>
  (parseFloat(getComputedStyle(document.documentElement).fontSize) || 14) / 14;

export function HostMetricsGrid({
  layout,
  editMode,
  renderCard,
  cardCatalog,
  cardLabel,
  onChange,
}: {
  layout: HostMetricsLayout;
  editMode: boolean;
  renderCard: (id: string) => ReactNode;
  cardCatalog: GridCardCatalogEntry[];
  cardLabel: (id: string) => string;
  onChange: (layout: HostMetricsLayout) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<string | null>(null);
  const preview = useRef<HTMLDivElement | null>(null);
  const lastDrop = useRef("");
  const clearPreview = () => {
    preview.current?.remove();
    preview.current = null;
    lastDrop.current = "";
  };
  const clearDrag = () => {
    clearPreview();
    drag.current = null;
  };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearDrag();
    };
    window.addEventListener("blur", clearDrag);
    window.addEventListener("resize", clearDrag);
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("keydown", key);
    return () => {
      clearDrag();
      window.removeEventListener("blur", clearDrag);
      window.removeEventListener("resize", clearDrag);
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("keydown", key);
    };
  }, [layout.slots, layout.columns, editMode]);
  const tileFor = (target: EventTarget) =>
    target instanceof Element
      ? target.closest<HTMLElement>("[data-hm-tile]")
      : null;
  const showDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!editMode || !drag.current || !root.current) return;
    const grid = root.current.querySelector<HTMLElement>("[data-hm-grid]");
    if (!grid) return;
    const original = Array.from(grid.children) as HTMLElement[];
    const source = original.find(
      (tile) => tile.dataset.hmTile === drag.current,
    );
    const target = tileFor(event.target);
    // Only tiles and the SDK's trailing drop zone are drop destinations.
    if (
      !source ||
      target === source ||
      (!target && event.target !== grid.parentElement?.lastElementChild)
    ) {
      clearPreview();
      return;
    }
    const next = original.filter((tile) => tile !== source);
    const index = target ? next.indexOf(target) : next.length;
    if (index < 0) return;
    next.splice(index, 0, source);
    const tracks = trackCount(grid.getBoundingClientRect().width);
    if (!tracks) return;
    const cells = next.map((tile) => ({
      width: Math.max(1, Number(tile.style.getPropertyValue("--hm-cols"))),
      height: Math.max(1, Number(tile.style.getPropertyValue("--hm-rows"))),
    }));
    const key = JSON.stringify([
      drag.current,
      target?.dataset.hmTile ?? "end",
      tracks,
      cells,
    ]);
    if (key === lastDrop.current) return;
    const position = packGrid(cells, tracks)[index];
    if (!position) return;
    const bounds = grid.getBoundingClientRect();
    const origin = root.current.getBoundingClientRect();
    const pitch = bounds.width / tracks;
    const gap = 12 * remScale();
    lastDrop.current = key;
    if (!preview.current) {
      preview.current = document.createElement("div");
      preview.current.dataset.hmDropPreview = drag.current;
      preview.current.setAttribute("aria-hidden", "true");
      root.current.appendChild(preview.current);
    }
    Object.assign(preview.current.style, {
      left: `${bounds.left + position.x * pitch - origin.left + root.current.scrollLeft}px`,
      top: `${bounds.top + position.y * UNIT - origin.top + root.current.scrollTop}px`,
      width: `${position.width * pitch - gap}px`,
      height: `${position.height * UNIT - gap}px`,
    });
  };
  return (
    <div
      ref={root}
      className="hm-card-grid"
      data-edit-mode={editMode}
      onDragStartCapture={(event) => {
        if (editMode)
          drag.current = tileFor(event.target)?.dataset.hmTile ?? null;
      }}
      onDragOverCapture={showDrop}
      onDropCapture={clearDrag}
      onDragEndCapture={clearDrag}
      onDragLeave={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          clearPreview();
      }}
    >
      <style>{sizedCardStyles}</style>
      <CardGridCanvas
        slots={layout.slots}
        columns={layout.columns}
        editMode={editMode}
        cardCatalog={cardCatalog}
        cardLabel={cardLabel}
        onChange={(slots, columns) =>
          onChange({
            slots: slots.map((slot) => {
              const previous = layout.slots.find((s) => s.id === slot.id);
              return { ...previous, ...slot } as Slot;
            }),
            columns,
          })
        }
        renderCard={(id) => {
          const slot = layout.slots.find((s) => s.id === id);
          if (!slot) return null;
          return (
            <SizedCard
              slot={slot}
              columns={layout.columns}
              label={cardLabel(id)}
              editMode={editMode}
              onChange={(patch) =>
                onChange({
                  ...layout,
                  slots: layout.slots.map((s) =>
                    s.id === id ? { ...s, ...patch } : s,
                  ),
                })
              }
            >
              {renderCard(id)}
            </SizedCard>
          );
        }}
      />
    </div>
  );
}

function SizedCard({
  slot,
  columns,
  label,
  editMode,
  onChange,
  children,
}: {
  slot: Slot;
  columns: number;
  label: string;
  editMode: boolean;
  onChange: (patch: Partial<Slot>) => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const element = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!editMode) setSettingsOpen(false);
  }, [editMode]);
  const cancel = useRef<(() => void) | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0, max: 0, min: 0 });
  const geometry = () => {
    const card = element.current;
    const tile = card?.parentElement?.parentElement;
    const grid = tile?.parentElement;
    if (!card || !tile || !grid?.classList.contains("grid")) return null;
    const scale = remScale();
    const gap = 12 * scale;
    const total = grid.getBoundingClientRect().width || grid.clientWidth;
    if (!total) return null;
    return {
      card,
      tile,
      grid,
      scale,
      gap,
      total,
      max: Math.min(MAX_CARD_WIDTH, total - gap),
      pitch: total / trackCount(total),
    };
  };
  useLayoutEffect(() => {
    const update = () => {
      const g = geometry();
      if (!g) return;
      g.grid.dataset.hmGrid = "true";
      g.tile.dataset.hmTile = slot.id;
      g.grid.style.setProperty("--hm-tracks", String(trackCount(g.total)));
      const width =
        slot.width == null
          ? (g.total / Math.max(1, columns)) * Math.min(slot.colSpan, columns) -
            g.gap
          : Math.max(
              Math.min(MIN_CARD_WIDTH, g.max),
              Math.min(slot.width, g.max),
            );
      g.tile.style.setProperty(
        "--hm-cols",
        String(Math.max(1, Math.round((width + g.gap) / g.pitch))),
      );
      const height =
        slot.height == null
          ? g.card.getBoundingClientRect().height
          : slot.height * g.scale;
      g.tile.style.setProperty("--hm-rows", String(rowSpan(height, g.gap)));
      const next = {
        width,
        height,
        min: Math.min(MIN_CARD_WIDTH, g.max),
        max: g.max,
      };
      setSize((old) =>
        Object.keys(next).every(
          (k) => old[k as keyof typeof old] === next[k as keyof typeof next],
        )
          ? old
          : next,
      );
    };
    update();
    const observer = new ResizeObserver(update);
    const g = geometry();
    if (g) {
      observer.observe(g.grid);
      observer.observe(g.card);
    }
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [slot.width, slot.height, slot.colSpan, columns, editMode]);
  useEffect(() => () => cancel.current?.(), [editMode, slot, columns]);

  const startResize = (
    event: PointerEvent<HTMLDivElement>,
    axis: "width" | "height" | "both",
    fromLeft = false,
  ) => {
    if (event.button !== 0 || cancel.current) return;
    const g = geometry();
    const root = element.current?.closest<HTMLElement>(".hm-card-grid");
    if (!g || !root || window.matchMedia?.("(max-width: 767px)").matches)
      return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    // A resize leaves text editing and exposes the existing keyboard sizing control.
    const focusTarget =
      axis === "both" || fromLeft
        ? g.card.querySelector<HTMLElement>(".hm-width-handle[tabindex]")
        : handle;
    focusTarget?.focus({ preventScroll: true });
    const pointerId = event.pointerId;
    const resizeWidth = axis !== "height";
    const resizeHeight = axis !== "width";
    const startX = event.clientX;
    const startY = event.clientY;
    const startWidth = g.tile.getBoundingClientRect().width || size.width;
    const startHeight = g.card.getBoundingClientRect().height || size.height;
    let width = startWidth;
    let height = startHeight;
    let moved = false;
    const ghost = document.createElement("div");
    ghost.dataset.hmResizePreview = slot.id;
    ghost.setAttribute("aria-hidden", "true");
    root.appendChild(ghost);
    const guides = (["x", "y"] as const).map((axis) => {
      const guide = document.createElement("div");
      guide.className = "hm-snap-guide";
      guide.dataset.hmSnapGuide = slot.id;
      guide.dataset.axis = axis;
      guide.setAttribute("aria-hidden", "true");
      guide.style.display = "none";
      root.appendChild(guide);
      return guide;
    });
    g.card.dataset.hmResizing = "true";
    g.tile.dataset.hmResizing = "true";
    const preview = () => {
      let snappedX: number | undefined;
      let snappedY: number | undefined;
      const column = g.tile.style.getPropertyValue("--hm-cols");
      const row = g.tile.style.getPropertyValue("--hm-rows");
      const inner = g.card.parentElement!;
      const previousHeight = inner.style.height;
      // Measure the actual proposed dense packing, then restore before paint/reflow is visible.
      if (resizeWidth)
        g.tile.style.setProperty(
          "--hm-cols",
          String(Math.max(1, Math.round((width + g.gap) / g.pitch))),
        );
      if (resizeHeight) inner.style.height = `${height}px`;
      let h =
        g.card.getBoundingClientRect().height ||
        (resizeHeight ? height : size.height);
      g.tile.style.setProperty("--hm-rows", String(rowSpan(h, g.gap)));
      let rect = g.tile.getBoundingClientRect();
      const bounds = g.grid.getBoundingClientRect();
      const siblings = Array.from(
        g.grid.querySelectorAll<HTMLElement>("[data-hm-tile]"),
      ).filter((tile) => tile !== g.tile);
      const threshold = 8 * g.scale;
      const nearest = (value: number, targets: number[]) =>
        targets.reduce(
          (best, target) =>
            Math.abs(target - value) < Math.abs(best - value) ? target : best,
          value + threshold + 1,
        );
      if (resizeWidth && moved) {
        const targets = [bounds.left + g.total - g.gap];
        for (let i = 1; i < columns; i++)
          targets.push(bounds.left + (g.total * i) / columns - g.gap);
        for (const tile of siblings) {
          const r = tile.getBoundingClientRect();
          targets.push(r.left + r.width, r.left - g.gap);
        }
        const right = rect.left + rect.width;
        const edge = nearest(right, targets);
        const proposed = Math.round(width + edge - right);
        if (
          Math.abs(edge - right) <= threshold &&
          proposed >= size.min &&
          proposed <= g.max
        ) {
          const previousWidth = width;
          width = proposed;
          g.tile.style.setProperty(
            "--hm-cols",
            String(Math.max(1, Math.round((width + g.gap) / g.pitch))),
          );
          rect = g.tile.getBoundingClientRect();
          // A snap that changes dense rows must still land on the predicted edge.
          if (Math.abs(rect.left + rect.width - edge) > g.pitch) {
            width = previousWidth;
            g.tile.style.setProperty(
              "--hm-cols",
              String(Math.max(1, Math.round((width + g.gap) / g.pitch))),
            );
            rect = g.tile.getBoundingClientRect();
          }
          h = g.card.getBoundingClientRect().height || h;
          g.tile.style.setProperty("--hm-rows", String(rowSpan(h, g.gap)));
          rect = g.tile.getBoundingClientRect();
          if (Math.abs(rect.left + rect.width - edge) <= g.pitch)
            snappedX = edge;
        }
      }
      if (resizeHeight && moved) {
        const bottom = rect.top + h;
        const targets = siblings.flatMap((tile) => {
          const r = tile.getBoundingClientRect();
          return [r.top + r.height, r.top - g.gap];
        });
        const edge = nearest(bottom, targets);
        const proposed = Math.round(height + edge - bottom);
        if (
          Math.abs(edge - bottom) <= threshold &&
          proposed >= 80 * g.scale &&
          proposed <= 10000 * g.scale
        ) {
          const previousHeight = height;
          height = proposed;
          inner.style.height = `${height}px`;
          g.tile.style.setProperty("--hm-rows", String(rowSpan(height, g.gap)));
          rect = g.tile.getBoundingClientRect();
          if (Math.abs(rect.top + height - edge) > UNIT) {
            height = previousHeight;
            inner.style.height = `${height}px`;
            g.tile.style.setProperty(
              "--hm-rows",
              String(rowSpan(height, g.gap)),
            );
            rect = g.tile.getBoundingClientRect();
          }
          if (Math.abs(rect.top + height - edge) <= UNIT) snappedY = edge;
        }
      }
      if (
        snappedX !== undefined &&
        Math.abs(rect.left + rect.width - snappedX) > g.pitch
      )
        snappedX = undefined;
      const origin = root.getBoundingClientRect();
      Object.assign(guides[0].style, {
        display: snappedX === undefined ? "none" : "block",
        left: `${(snappedX ?? 0) - origin.left + root.scrollLeft}px`,
        top: "0px",
        height: `${Math.max(root.scrollHeight, origin.height)}px`,
      });
      Object.assign(guides[1].style, {
        display: snappedY === undefined ? "none" : "block",
        left: "0px",
        top: `${(snappedY ?? 0) - origin.top + root.scrollTop}px`,
        width: `${Math.max(root.scrollWidth, origin.width)}px`,
      });
      Object.assign(ghost.style, {
        left: `${rect.left - origin.left + root.scrollLeft}px`,
        top: `${rect.top - origin.top + root.scrollTop}px`,
        width: `${rect.width || (resizeWidth ? width : size.width)}px`,
        height: `${resizeHeight ? height : h}px`,
      });
      g.tile.style.setProperty("--hm-cols", column);
      g.tile.style.setProperty("--hm-rows", row);
      inner.style.height = previousHeight;
    };
    const move = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      moved =
        (resizeWidth && e.clientX !== startX) ||
        (resizeHeight && e.clientY !== startY);
      if (resizeWidth)
        width = Math.round(
          Math.max(
            size.min,
            Math.min(
              g.max,
              startWidth + (e.clientX - startX) * (fromLeft ? -1 : 1),
            ),
          ),
        );
      if (resizeHeight)
        height = Math.round(
          Math.max(
            80 * g.scale,
            Math.min(10000 * g.scale, startHeight + e.clientY - startY),
          ),
        );
      preview();
    };
    const clear = () => {
      ghost.remove();
      for (const guide of guides) guide.remove();
      delete g.card.dataset.hmResizing;
      delete g.tile.dataset.hmResizing;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("blur", clear);
      window.removeEventListener("resize", clear);
      window.removeEventListener("keydown", key);
      handle.removeEventListener("lostpointercapture", clear);
      cancel.current = null;
      if (handle.hasPointerCapture(pointerId))
        handle.releasePointerCapture(pointerId);
    };
    const up = (e: globalThis.PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      clear();
      const patch: Partial<Slot> = {};
      if (resizeWidth && width !== startWidth) patch.width = width;
      if (resizeHeight && height !== startHeight)
        patch.height = Math.round(height / g.scale);
      if (Object.keys(patch).length) onChange(patch);
    };
    const cancelled = (e: globalThis.PointerEvent) => {
      if (e.pointerId === pointerId) clear();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        clear();
      }
    };
    cancel.current = clear;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelled);
    window.addEventListener("blur", clear);
    window.addEventListener("resize", clear);
    window.addEventListener("keydown", key);
    handle.addEventListener("lostpointercapture", clear);
    handle.setPointerCapture(pointerId);
    preview();
  };
  return (
    <div
      ref={element}
      className="hm-sized-card relative flex h-full min-h-0 min-w-0 flex-col"
      data-hm-card={slot.id}
      data-fixed-height={slot.height != null}
    >
      <div className="hm-card-content min-h-0 flex-1">{children}</div>
      {editMode && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="hm-card-settings"
          title={t("hostMetrics.cardSettings.title", { card: label })}
          aria-label={t("hostMetrics.cardSettings.title", { card: label })}
          onClick={() => setSettingsOpen(true)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <Settings2 className="size-3.5" />
        </Button>
      )}
      {editMode && settingsOpen && (
        <CardSettingsView
          id={slot.id}
          label={label}
          slot={slot}
          renderedWidth={size.width}
          renderedHeight={size.height / remScale()}
          onSave={onChange}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {editMode && (
        <div
          aria-hidden="true"
          title={t("hostMetrics.cardWidth")}
          className="hm-resize-handle hm-width-handle hm-left-handle"
          draggable={false}
          onPointerDown={(event) => startResize(event, "width", true)}
          onMouseDown={(event) => event.stopPropagation()}
          onDragStart={(event) => event.preventDefault()}
        >
          <span className="h-12 w-0.5 rounded-full bg-border" />
        </div>
      )}
      {editMode &&
        (["width", "height"] as const).map((axis) => (
          <div
            key={axis}
            role="separator"
            aria-orientation={axis === "width" ? "vertical" : "horizontal"}
            aria-label={`${label}: ${t(axis === "width" ? "hostMetrics.cardWidth" : "hostMetrics.cardHeight")}`}
            aria-valuemin={axis === "width" ? Math.round(size.min) : 80}
            aria-valuemax={axis === "width" ? Math.round(size.max) : 10000}
            aria-valuenow={Math.round(
              axis === "width" ? size.width : size.height / remScale(),
            )}
            tabIndex={0}
            title={t(
              axis === "width"
                ? "hostMetrics.cardWidth"
                : "hostMetrics.cardHeight",
            )}
            className={`hm-resize-handle hm-${axis}-handle`}
            draggable={false}
            onPointerDown={(e) => startResize(e, axis)}
            onMouseDown={(e) => e.stopPropagation()}
            onDragStart={(e) => e.preventDefault()}
            onKeyDown={(e) => {
              const keys =
                axis === "width"
                  ? ["ArrowLeft", "ArrowRight"]
                  : ["ArrowUp", "ArrowDown"];
              if (![...keys, "Home", "End"].includes(e.key)) return;
              e.preventDefault();
              e.stopPropagation();
              if (!geometry()) return;
              const min = axis === "width" ? size.min : 80;
              const max = axis === "width" ? size.max : 10000;
              const current =
                axis === "width" ? size.width : size.height / remScale();
              const value = Math.round(
                e.key === "Home"
                  ? min
                  : e.key === "End"
                    ? max
                    : Math.max(
                        min,
                        Math.min(
                          max,
                          current +
                            (e.key === keys[1] ? 1 : -1) *
                              (e.shiftKey ? 10 : 1),
                        ),
                      ),
              );
              if (value !== current)
                onChange(
                  axis === "width" ? { width: value } : { height: value },
                );
            }}
          >
            <span
              className={
                axis === "width"
                  ? "h-12 w-0.5 rounded-full bg-border"
                  : "h-0.5 w-12 rounded-full bg-border"
              }
            />
          </div>
        ))}
      {editMode && (
        <div
          aria-hidden="true"
          title={t("hostMetrics.cardSize")}
          className="hm-resize-handle hm-corner-handle"
          draggable={false}
          onPointerDown={(e) => startResize(e, "both")}
          onMouseDown={(e) => e.stopPropagation()}
          onDragStart={(e) => e.preventDefault()}
        />
      )}
    </div>
  );
}
