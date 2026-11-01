import { GripVertical, Plus, Settings2, Trash2 } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { type GridCardCatalogEntry } from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { CardSettingsView } from "./card-settings";
import {
  GRID_GAP,
  MAX_CARD_HEIGHT,
  MIN_CARD_HEIGHT,
  boxesFor,
  clampColumns,
  columnsFromSpan,
  gridBottom,
  placeSlots,
  settle,
  slotsFromBoxes,
  type Box,
  type PlacedSlot,
} from "./grid-layout";
import {
  GRID_COLUMNS,
  MIN_CARD_COLUMNS,
  type HostMetricsCardId,
  type HostMetricsLayout,
} from "../shared/host-metrics.js";

type Slot = HostMetricsLayout["slots"][number];
type Edge = "left" | "right" | "bottom" | "corner";
interface Proposal {
  x?: number;
  y?: number;
  w?: number;
  height?: number | null;
}
interface Interaction {
  id: string;
  kind: "move" | "resize";
  base: PlacedSlot[];
  proposal: Proposal;
  // Where the active card is drawn while it follows the pointer, in screen px.
  frame: { left: number; top: number; width: number; height?: number };
}

// Below this width cards stack in one column and editing is off.
const STACK_BELOW = 640;
const DRAG_THRESHOLD = 4;
const SNAP = 8;
const SCROLL_EDGE = 48;

const styles = `
.hm-card-grid { position: relative; }
.hm-tile { position: absolute; left: 0; top: 0; min-width: 0; display: flex; flex-direction: column; }
.hm-card-grid[data-animate="true"] .hm-tile:not([data-active]) { transition: transform 160ms ease, width 160ms ease, height 160ms ease; }
.hm-tile[data-active] { z-index: 40; }
.hm-tile[data-active="move"] { opacity: 0.85; cursor: grabbing; }
.hm-card-grid[data-edit-mode="true"] .hm-tile { user-select: none; }
.hm-card-grid[data-edit-mode="true"] .hm-tile:not([data-active]) { cursor: grab; }
.hm-card-grid[data-edit-mode="true"] .hm-card-content { padding-top: 2.5rem; box-sizing: border-box; }
[data-hm-drop-preview] {
  position: absolute; left: 0; top: 0; z-index: 5; pointer-events: none; box-sizing: border-box;
  background: color-mix(in srgb, var(--accent-brand, #60a5fa) 12%, transparent);
  border: 2px dashed color-mix(in srgb, var(--accent-brand, #60a5fa) 70%, transparent);
}
.hm-resize-handle { position: absolute; z-index: 30; display: flex; touch-action: none; align-items: center; justify-content: center; }
.hm-resize-handle > span { background: var(--border); }
.hm-resize-handle:hover > span { background: var(--accent-brand, #60a5fa); }
.hm-edge-left, .hm-edge-right { top: 2.5rem; bottom: 1rem; width: 0.75rem; cursor: ew-resize; }
.hm-edge-left { left: 0; }
.hm-edge-right { right: 0; }
.hm-edge-bottom { bottom: 0; left: 1rem; right: 1rem; height: 0.75rem; cursor: ns-resize; }
.hm-edge-corner { bottom: 0; right: 0; width: 1rem; height: 1rem; cursor: nwse-resize; }
.hm-edge-corner::after { content: ""; width: 0.5rem; height: 0.5rem; border-right: 2px solid var(--border); border-bottom: 2px solid var(--border); }
.hm-resize-handle:focus-visible { outline: 2px solid var(--accent-brand, #60a5fa); }
.hm-sized-card[data-fixed-height="true"] { height: 100%; }
.hm-sized-card[data-fixed-height="true"] > .hm-card-content { overflow: hidden; }
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

// Stored heights are in 14px-root units so they follow the interface size.
const remScale = () =>
  (parseFloat(getComputedStyle(document.documentElement).fontSize) || 14) / 14;

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));

function propose(base: PlacedSlot[], id: string, proposal: Proposal) {
  return base.map((slot) => {
    if (slot.id !== id) return slot;
    const next = { ...slot };
    if (proposal.x !== undefined) next.x = proposal.x;
    if (proposal.y !== undefined) next.y = proposal.y;
    if (proposal.w !== undefined) next.w = proposal.w;
    if (proposal.height !== undefined) next.height = proposal.height;
    return next;
  });
}

function scrollParent(element: HTMLElement | null) {
  for (let node = element?.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return node;
  }
  return null;
}

const NO_DRAG =
  "button, a, input, select, textarea, label, [role=separator], [contenteditable=true], .hm-resize-handle";

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
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const gridEl = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [active, setActive] = useState<Interaction | null>(null);
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const cancel = useRef<(() => void) | null>(null);
  const heightsRef = useRef(heights);
  heightsRef.current = heights;

  const scale = remScale();
  const gap = GRID_GAP * scale;
  const pitch = (width + gap) / GRID_COLUMNS;
  const stacked = width > 0 && width < STACK_BELOW;
  const editing = editMode && !stacked;

  const slots = useMemo(() => placeSlots(layout), [layout]);
  const settled = useMemo(
    () => settle(boxesFor(slots, heights)),
    [slots, heights],
  );
  const preview = useMemo(
    () =>
      active
        ? settle(
            boxesFor(propose(active.base, active.id, active.proposal), heights),
          )
        : settled,
    [active, settled, heights],
  );
  const boxById = useMemo(
    () => new Map(preview.map((box) => [box.id, box])),
    [preview],
  );
  // Same elements across pointer moves, so cards only re-render on new data.
  const content = useMemo(
    () =>
      new Map<string, ReactNode>(
        slots.map((slot) => [slot.id, renderCard(slot.id)]),
      ),
    [slots, renderCard],
  );

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () =>
      setWidth(element.getBoundingClientRect().width || element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!editMode) setSettingsFor(null);
  }, [editMode]);
  // An outside change (undo, template, host switch) ends any drag in progress.
  useEffect(() => () => cancel.current?.(), [layout, editing]);

  const reportHeight = useCallback(
    (id: string, height: number) =>
      setHeights((previous) =>
        Math.abs((previous[id] ?? -1) - height) < 0.5
          ? previous
          : { ...previous, [id]: height },
      ),
    [],
  );

  const commit = (
    base: PlacedSlot[],
    id: string | null,
    proposal: Proposal,
  ) => {
    const next = id ? propose(base, id, proposal) : base;
    const boxes = settle(boxesFor(next, heightsRef.current));
    onChange({ columns: layout.columns, slots: slotsFromBoxes(next, boxes) });
  };
  const settledBase = (): PlacedSlot[] =>
    slots.map((slot) => ({
      ...slot,
      y: settled.find((box) => box.id === slot.id)?.y ?? slot.y,
    }));

  const begin = (
    event: ReactPointerEvent<HTMLElement>,
    id: string,
    edge?: Edge,
  ) => {
    if (event.button !== 0 || !editing || cancel.current) return;
    const element = gridEl.current;
    const box = settled.find((b) => b.id === id);
    const slot = slots.find((s) => s.id === id);
    if (!element || !box || !slot) return;
    if (!edge) {
      const target = event.target as HTMLElement;
      if (target.closest(NO_DRAG) && !target.closest("[data-hm-grip]")) return;
      const native = event.nativeEvent;
      // Leave scrollbars inside cards alone.
      const scrolls =
        target.scrollHeight > target.clientHeight ||
        target.scrollWidth > target.clientWidth;
      if (
        scrolls &&
        (native.offsetX > target.clientWidth ||
          native.offsetY > target.clientHeight)
      )
        return;
    } else {
      event.preventDefault();
      event.stopPropagation();
    }
    const kind = edge ? "resize" : "move";
    const base = settledBase();
    const origin = element.getBoundingClientRect();
    const startLeft = box.x * pitch;
    const startTop = box.y * scale;
    const startWidth = box.w * pitch - gap;
    const startHeight = box.h * scale;
    const fixed = slot.height != null;
    const startX = event.clientX;
    const startY = event.clientY;
    const grabX = startX - origin.left - startLeft;
    const grabY = startY - origin.top - startTop;
    const scroller = scrollParent(element);
    const others = settled.filter((b) => b.id !== id);
    let pointer = { x: startX, y: startY };
    let started = kind === "resize";
    let current: Interaction | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;

    const compute = () => {
      const rect = element.getBoundingClientRect();
      if (kind === "move") {
        const left = pointer.x - rect.left - grabX;
        const top = pointer.y - rect.top - grabY;
        return {
          id,
          kind,
          base,
          proposal: {
            x: clamp(Math.round(left / pitch), 0, GRID_COLUMNS - box.w),
            y: Math.max(0, top / scale),
          },
          frame: {
            left,
            top,
            width: startWidth,
            height: fixed ? startHeight : undefined,
          },
        } satisfies Interaction;
      }
      const dx = pointer.x - startX;
      const dy = pointer.y - rect.top - (startY - origin.top);
      const proposal: Proposal = {};
      const frame: Interaction["frame"] = {
        left: startLeft,
        top: startTop,
        width: startWidth,
        height: fixed ? startHeight : undefined,
      };
      const minWidth = MIN_CARD_COLUMNS * pitch - gap;
      if (edge === "right" || edge === "corner") {
        const raw = clamp(
          startWidth + dx,
          minWidth,
          (GRID_COLUMNS - box.x) * pitch - gap,
        );
        proposal.w = Math.min(
          clampColumns((raw + gap) / pitch),
          GRID_COLUMNS - box.x,
        );
        frame.width = raw;
      }
      if (edge === "left") {
        const right = box.x + box.w;
        const raw = clamp(startWidth - dx, minWidth, right * pitch - gap);
        proposal.w = Math.min(clampColumns((raw + gap) / pitch), right);
        proposal.x = right - proposal.w;
        frame.width = raw;
        frame.left = startLeft + startWidth - raw;
      }
      if (edge === "bottom" || edge === "corner") {
        let height =
          clamp(
            startHeight + dy,
            MIN_CARD_HEIGHT * scale,
            MAX_CARD_HEIGHT * scale,
          ) / scale;
        // Line up with the bottom of a nearby card.
        for (const other of others) {
          const bottom = other.y + other.h - box.y;
          if (bottom >= MIN_CARD_HEIGHT && Math.abs(bottom - height) <= SNAP) {
            height = bottom;
            break;
          }
        }
        proposal.height = Math.round(height);
        frame.height = proposal.height * scale;
      }
      return { id, kind, base, proposal, frame } satisfies Interaction;
    };
    const update = () => {
      current = compute();
      setActive(current);
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== event.pointerId) return;
      pointer = { x: e.clientX, y: e.clientY };
      if (
        !started &&
        Math.hypot(pointer.x - startX, pointer.y - startY) < DRAG_THRESHOLD
      )
        return;
      if (!started) {
        started = true;
        window.getSelection?.()?.removeAllRanges();
        if (scroller) timer = setInterval(autoScroll, 16);
      }
      update();
    };
    const autoScroll = () => {
      if (!scroller) return;
      const rect = scroller.getBoundingClientRect();
      const step =
        pointer.y < rect.top + SCROLL_EDGE
          ? -12
          : pointer.y > rect.bottom - SCROLL_EDGE
            ? 12
            : 0;
      if (!step) return;
      const before = scroller.scrollTop;
      scroller.scrollTop += step;
      if (scroller.scrollTop !== before) update();
    };
    const finish = (save: boolean) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancelled);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
      clearInterval(timer);
      cancel.current = null;
      setActive(null);
      if (save && started && current) commit(base, id, current.proposal);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId === event.pointerId) finish(true);
    };
    const cancelled = (e: PointerEvent) => {
      if (e.pointerId === event.pointerId) finish(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      finish(false);
    };
    const blur = () => finish(false);
    cancel.current = () => finish(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancelled);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    if (started) update();
  };

  const moveByKey = (event: ReactKeyboardEvent, id: string) => {
    const box = settled.find((b) => b.id === id);
    if (!box) return;
    const near = settled.filter(
      (b) => b.id !== id && b.x < box.x + box.w && box.x < b.x + b.w,
    );
    let proposal: Proposal | null = null;
    if (event.key === "ArrowLeft" && box.x > 0) proposal = { x: box.x - 1 };
    if (event.key === "ArrowRight" && box.x + box.w < GRID_COLUMNS)
      proposal = { x: box.x + 1 };
    if (event.key === "ArrowUp") {
      const above = near
        .filter((b) => b.y < box.y)
        .sort((a, b) => b.y - a.y)[0];
      if (above) proposal = { y: Math.max(0, above.y - 1) };
    }
    if (event.key === "ArrowDown") {
      const below = near
        .filter((b) => b.y > box.y)
        .sort((a, b) => a.y - b.y)[0];
      if (below) proposal = { y: below.y + 1 };
    }
    if (!event.key.startsWith("Arrow")) return;
    event.preventDefault();
    if (proposal) commit(settledBase(), id, proposal);
  };

  const resizeByKey = (
    event: ReactKeyboardEvent,
    id: string,
    axis: "width" | "height",
  ) => {
    const box = settled.find((b) => b.id === id);
    if (!box) return;
    const keys =
      axis === "width" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
    if (![...keys, "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const sign = event.key === keys[1] ? 1 : -1;
    if (axis === "width") {
      const max = GRID_COLUMNS - box.x;
      const w =
        event.key === "Home"
          ? MIN_CARD_COLUMNS
          : event.key === "End"
            ? max
            : clamp(box.w + sign, MIN_CARD_COLUMNS, max);
      if (w !== box.w) commit(settledBase(), id, { w });
    } else {
      const current = Math.round(box.h);
      const height =
        event.key === "Home"
          ? MIN_CARD_HEIGHT
          : event.key === "End"
            ? MAX_CARD_HEIGHT
            : clamp(
                current + sign * (event.shiftKey ? 50 : 10),
                MIN_CARD_HEIGHT,
                MAX_CARD_HEIGHT,
              );
      if (height !== current) commit(settledBase(), id, { height });
    }
  };

  const remove = (id: string) =>
    commit(
      settledBase().filter((slot) => slot.id !== id),
      null,
      {},
    );
  const add = (entry: GridCardCatalogEntry) => {
    const colSpan = entry.defaultColSpan ?? 1;
    const slot: PlacedSlot = {
      id: entry.id as HostMetricsCardId,
      order: slots.length,
      colSpan,
      height: entry.defaultHeight ?? null,
      x: 0,
      y: Math.round(gridBottom(settled)),
      w: columnsFromSpan(colSpan, layout.columns),
    };
    commit([...settledBase(), slot], null, {});
  };
  const saveSettings = (id: string, patch: Partial<Slot>) => {
    const base = settledBase().map((slot) => {
      if (slot.id !== id) return slot;
      const w = clampColumns(patch.w ?? slot.w);
      return {
        ...slot,
        ...patch,
        w,
        x: Math.min(slot.x, GRID_COLUMNS - w),
        y: slot.y,
      };
    });
    commit(base, null, {});
  };

  if (stacked) {
    return (
      <div ref={root} className="flex flex-col gap-3">
        {[...settled]
          .sort((a, b) => a.y - b.y || a.x - b.x)
          .map((box) => (
            <div key={box.id} className="w-full min-w-0">
              {content.get(box.id)}
            </div>
          ))}
      </div>
    );
  }

  const activeBox = active ? boxById.get(active.id) : undefined;
  const presentIds = new Set<string>(slots.map((slot) => slot.id));
  const addable = cardCatalog.filter((entry) => !presentIds.has(entry.id));
  const settingsSlot = slots.find((slot) => slot.id === settingsFor);
  const settingsBox = settled.find((box) => box.id === settingsFor);

  return (
    <div ref={root}>
      <div
        ref={gridEl}
        className="hm-card-grid"
        data-edit-mode={editing}
        data-animate={editing}
        style={{ height: Math.max(0, gridBottom(preview) * scale - gap) }}
      >
        <style>{styles}</style>
        {activeBox && (
          <div
            data-hm-drop-preview={activeBox.id}
            aria-hidden="true"
            style={{
              transform: `translate(${activeBox.x * pitch}px, ${activeBox.y * scale}px)`,
              width: activeBox.w * pitch - gap,
              height: activeBox.h * scale,
            }}
          />
        )}
        {slots.map((slot) => {
          const box = boxById.get(slot.id)!;
          const frame = active?.id === slot.id ? active.frame : null;
          const height = frame
            ? frame.height
            : slot.height != null
              ? slot.height * scale
              : undefined;
          return (
            <Tile
              key={slot.id}
              slot={slot}
              box={box}
              label={cardLabel(slot.id)}
              editMode={editing}
              active={active?.id === slot.id ? active.kind : undefined}
              left={frame ? frame.left : box.x * pitch}
              top={frame ? frame.top : box.y * scale}
              width={frame ? frame.width : box.w * pitch - gap}
              height={height}
              scale={scale}
              onHeight={reportHeight}
              onPointerDown={(event, edge) => begin(event, slot.id, edge)}
              onMoveKey={(event) => moveByKey(event, slot.id)}
              onResizeKey={(event, axis) => resizeByKey(event, slot.id, axis)}
              onSettings={() => setSettingsFor(slot.id)}
              onRemove={() => remove(slot.id)}
            >
              {content.get(slot.id)}
            </Tile>
          );
        })}
      </div>
      {editing && slots.length === 0 && (
        <div className="flex items-center justify-center border border-dashed border-border/40 py-10 text-xs text-muted-foreground">
          {t("hostMetrics.grid.empty")}
        </div>
      )}
      {editing && addable.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {t("hostMetrics.grid.addCard")}
          </span>
          {addable.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => add(entry)}
              title={entry.description}
              className="flex items-center gap-1.5 border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-accent-brand/60 hover:bg-accent-brand/5 hover:text-foreground"
            >
              <Plus className="size-3 text-accent-brand" />
              {entry.label}
            </button>
          ))}
        </div>
      )}
      {editing && settingsSlot && settingsBox && (
        <CardSettingsView
          id={settingsSlot.id}
          label={cardLabel(settingsSlot.id)}
          slot={settingsSlot}
          renderedHeight={Math.round(settingsBox.h)}
          onSave={(patch) => saveSettings(settingsSlot.id, patch)}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  );
}

function Tile({
  slot,
  box,
  label,
  editMode,
  active,
  left,
  top,
  width,
  height,
  scale,
  onHeight,
  onPointerDown,
  onMoveKey,
  onResizeKey,
  onSettings,
  onRemove,
  children,
}: {
  slot: PlacedSlot;
  box: Box;
  label: string;
  editMode: boolean;
  active?: Interaction["kind"];
  left: number;
  top: number;
  width: number;
  height?: number;
  scale: number;
  onHeight: (id: string, height: number) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, edge?: Edge) => void;
  onMoveKey: (event: ReactKeyboardEvent) => void;
  onResizeKey: (event: ReactKeyboardEvent, axis: "width" | "height") => void;
  onSettings: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const card = useRef<HTMLDivElement>(null);
  const fixed = height !== undefined;

  // Auto height cards report their natural height so the grid can place them.
  useLayoutEffect(() => {
    const element = card.current;
    if (!element || fixed) return;
    const report = () =>
      onHeight(slot.id, element.getBoundingClientRect().height / scale);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => observer.disconnect();
  }, [slot.id, fixed, scale, onHeight]);

  const handle = (edge: Edge, className: string, extra = {}) => (
    <div
      className={`hm-resize-handle ${className}`}
      draggable={false}
      onPointerDown={(event) => onPointerDown(event, edge)}
      {...extra}
    />
  );

  return (
    <div
      data-hm-tile={slot.id}
      data-active={active}
      className="hm-tile"
      style={{
        transform: `translate(${left}px, ${top}px)`,
        width,
        height,
      }}
      onPointerDown={editMode ? (event) => onPointerDown(event) : undefined}
    >
      <div
        ref={card}
        className="hm-sized-card relative flex min-h-0 min-w-0 flex-col"
        data-hm-card={slot.id}
        data-fixed-height={fixed}
      >
        <div className="hm-card-content min-h-0 flex-1">{children}</div>
        {editMode && (
          <>
            <div className="pointer-events-none absolute inset-0 z-10 border-2 border-dashed border-accent-brand/30" />
            <div className="absolute top-2 right-2 z-20 flex items-center gap-1">
              <button
                type="button"
                className="flex size-6 cursor-grab items-center justify-center border border-border bg-card active:cursor-grabbing"
                title={t("hostMetrics.grid.move")}
                aria-label={t("hostMetrics.grid.moveCard", { card: label })}
                onKeyDown={onMoveKey}
                data-hm-grip
              >
                <GripVertical className="size-3 text-muted-foreground" />
              </button>
              <button
                type="button"
                className="flex size-6 items-center justify-center border border-border bg-card text-muted-foreground hover:text-foreground"
                title={t("hostMetrics.cardSettings.title", { card: label })}
                aria-label={t("hostMetrics.cardSettings.title", {
                  card: label,
                })}
                onClick={onSettings}
              >
                <Settings2 className="size-3" />
              </button>
              <button
                type="button"
                onClick={onRemove}
                className="flex size-6 items-center justify-center border border-border bg-card transition-colors hover:border-destructive/40 hover:bg-destructive/10"
                title={t("hostMetrics.grid.removeCard", { card: label })}
                aria-label={t("hostMetrics.grid.removeCard", { card: label })}
              >
                <Trash2 className="size-3 text-muted-foreground" />
              </button>
            </div>
            {handle("left", "hm-edge-left", {
              "aria-hidden": true,
              title: t("hostMetrics.cardWidth"),
            })}
            {(["width", "height"] as const).map((axis) => (
              <div
                key={axis}
                role="separator"
                tabIndex={0}
                aria-orientation={axis === "width" ? "vertical" : "horizontal"}
                aria-label={`${label}: ${t(axis === "width" ? "hostMetrics.cardWidth" : "hostMetrics.cardHeight")}`}
                aria-valuemin={
                  axis === "width" ? MIN_CARD_COLUMNS : MIN_CARD_HEIGHT
                }
                aria-valuemax={
                  axis === "width" ? GRID_COLUMNS : MAX_CARD_HEIGHT
                }
                aria-valuenow={axis === "width" ? box.w : Math.round(box.h)}
                title={t(
                  axis === "width"
                    ? "hostMetrics.cardWidth"
                    : "hostMetrics.cardHeight",
                )}
                className={`hm-resize-handle ${axis === "width" ? "hm-edge-right" : "hm-edge-bottom"}`}
                draggable={false}
                onPointerDown={(event) =>
                  onPointerDown(event, axis === "width" ? "right" : "bottom")
                }
                onKeyDown={(event) => onResizeKey(event, axis)}
              >
                <span
                  className={
                    axis === "width"
                      ? "h-12 w-0.5 rounded-full"
                      : "h-0.5 w-12 rounded-full"
                  }
                />
              </div>
            ))}
            {handle("corner", "hm-edge-corner", {
              "aria-hidden": true,
              title: t("hostMetrics.cardSize"),
            })}
          </>
        )}
      </div>
    </div>
  );
}
