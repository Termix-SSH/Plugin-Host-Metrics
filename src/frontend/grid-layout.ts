import {
  GRID_COLUMNS,
  MIN_CARD_COLUMNS,
  type HostMetricsColSpan,
  type HostMetricsLayout,
} from "../shared/host-metrics.js";

type Slot = HostMetricsLayout["slots"][number];
export type PlacedSlot = Slot & { x: number; y: number; w: number };

/** A card on the grid. x and w are columns, y and h are unscaled px. */
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const GRID_GAP = 12;
export const MIN_CARD_HEIGHT = 80;
export const MAX_CARD_HEIGHT = 10000;
// Legacy pixel widths were saved against a grid this wide.
const LEGACY_GRID_WIDTH = 1400;

export const clampColumns = (w: number) =>
  Math.max(MIN_CARD_COLUMNS, Math.min(GRID_COLUMNS, Math.round(w)));

export function columnsFromSpan(colSpan: number, columns: number) {
  const count = Math.max(1, Math.min(4, Math.round(columns) || 3));
  return clampColumns((Math.min(colSpan, count) * GRID_COLUMNS) / count);
}

function legacyColumns(slot: Slot, columns: number) {
  if (slot.width != null)
    return clampColumns(
      ((slot.width + GRID_GAP) / (LEGACY_GRID_WIDTH + GRID_GAP)) * GRID_COLUMNS,
    );
  return columnsFromSpan(slot.colSpan, columns);
}

/**
 * Gives every slot a grid position. Older layouts only have an order and a
 * width, so those flow left to right into rows below the placed cards.
 */
export function placeSlots(layout: HostMetricsLayout): PlacedSlot[] {
  const placed: PlacedSlot[] = [];
  const loose: Slot[] = [];
  for (const slot of layout.slots) {
    if (slot.x != null && slot.y != null && slot.w != null) {
      const w = clampColumns(slot.w);
      placed.push({
        ...slot,
        w,
        x: Math.min(slot.x, GRID_COLUMNS - w),
        y: slot.y,
      });
    } else loose.push(slot);
  }
  let row = placed.reduce((max, slot) => Math.max(max, slot.y + 1), 0);
  let x = 0;
  for (const slot of [...loose].sort((a, b) => a.order - b.order)) {
    const w = legacyColumns(slot, layout.columns);
    if (x + w > GRID_COLUMNS) {
      x = 0;
      row++;
    }
    placed.push({ ...slot, x, y: row, w });
    x += w;
  }
  return placed;
}

const overlapsX = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w;

/**
 * Settles cards top to bottom in (y, x) order. Each card sits right under the
 * lowest card placed before it in the columns it covers. Cards never move
 * sideways and never jump above a card that came before them.
 */
export function settle(boxes: Box[], gap = GRID_GAP): Box[] {
  const order = [...boxes].sort(
    (a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1),
  );
  const placed: Box[] = [];
  for (const box of order) {
    const y = placed.reduce(
      (top, p) => (overlapsX(p, box) ? Math.max(top, p.y + p.h + gap) : top),
      0,
    );
    placed.push({ ...box, y });
  }
  return placed;
}

export function boxesFor(
  slots: PlacedSlot[],
  heights: Record<string, number>,
  fallback = 200,
): Box[] {
  return slots.map((slot) => ({
    id: slot.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.height ?? heights[slot.id] ?? fallback,
  }));
}

export function gridBottom(boxes: Box[], gap = GRID_GAP) {
  return boxes.reduce((max, box) => Math.max(max, box.y + box.h + gap), 0);
}

/** Writes settled boxes back into slots, keeping order and colSpan for older clients. */
export function slotsFromBoxes(
  slots: PlacedSlot[],
  boxes: Box[],
): HostMetricsLayout["slots"] {
  const byId = new Map(boxes.map((box) => [box.id, box]));
  return [...slots]
    .map((slot) => {
      const box = byId.get(slot.id)!;
      const { width: _legacy, ...rest } = slot;
      return { ...rest, x: box.x, y: Math.round(box.y), w: box.w };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((slot, order) => ({
      ...slot,
      order,
      colSpan: Math.max(
        1,
        Math.min(3, Math.round(slot.w / (GRID_COLUMNS / 3))),
      ) as HostMetricsColSpan,
    }));
}
