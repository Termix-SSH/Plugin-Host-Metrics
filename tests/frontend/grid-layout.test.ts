import { describe, expect, it } from "vitest";
import {
  boxesFor,
  placeSlots,
  settle,
  slotsFromBoxes,
  type Box,
} from "../../src/frontend/grid-layout";
import { sanitizeLayout } from "../../src/shared/host-metrics.js";

const box = (id: string, x: number, y: number, w: number, h = 100): Box => ({
  id,
  x,
  y,
  w,
  h,
});
const at = (boxes: Box[], id: string) => boxes.find((b) => b.id === id)!;

describe("settle", () => {
  it("floats cards up but never sideways", () => {
    const out = settle([box("a", 0, 500, 4), box("b", 6, 900, 6)]);
    expect(at(out, "a")).toMatchObject({ x: 0, y: 0 });
    expect(at(out, "b")).toMatchObject({ x: 6, y: 0 });
  });

  it("pushes only overlapping cards down when one gets wider", () => {
    const out = settle([
      box("a", 0, 0, 6),
      box("b", 4, 0, 4),
      box("c", 8, 0, 4),
    ]);
    expect(at(out, "a").y).toBe(0);
    expect(at(out, "b")).toMatchObject({ x: 4, y: 112 });
    expect(at(out, "c")).toMatchObject({ x: 8, y: 0 });
  });

  it("does not let a card jump over the card above it", () => {
    // d sits below the wide card c; a gap next to b must not pull it above c.
    const out = settle([
      box("a", 0, 0, 6, 100),
      box("b", 6, 0, 6, 400),
      box("c", 0, 120, 12, 50),
      box("d", 0, 200, 6, 50),
    ]);
    expect(at(out, "c").y).toBe(412);
    expect(at(out, "d").y).toBe(474);
  });

  it("is stable when run again on its own output", () => {
    const once = settle([
      box("a", 0, 3, 4, 250),
      box("b", 4, 1, 8, 80),
      box("c", 2, 2, 6, 120),
    ]);
    expect(settle(once)).toEqual(once);
  });
});

describe("placeSlots", () => {
  it("flows legacy slots into rows by order and column span", () => {
    const slots = placeSlots({
      columns: 3,
      slots: [
        { id: "memory", order: 1, colSpan: 2, height: null },
        { id: "cpu", order: 0, colSpan: 1, height: null },
        { id: "disk", order: 2, colSpan: 1, height: 300 },
      ],
    });
    expect(slots.map(({ id, x, y, w }) => ({ id, x, y, w }))).toEqual([
      { id: "cpu", x: 0, y: 0, w: 4 },
      { id: "memory", x: 4, y: 0, w: 8 },
      { id: "disk", x: 0, y: 1, w: 4 },
    ]);
  });

  it("converts legacy pixel widths and keeps saved positions", () => {
    const slots = placeSlots({
      columns: 3,
      slots: [
        { id: "cpu", order: 0, colSpan: 1, height: null, width: 688 },
        { id: "gpu", order: 1, colSpan: 1, height: null, x: 11, y: 40, w: 4 },
      ],
    });
    expect(slots.find((s) => s.id === "gpu")).toMatchObject({ x: 8, y: 40 });
    expect(slots.find((s) => s.id === "cpu")).toMatchObject({ x: 0, w: 6 });
  });
});

describe("slotsFromBoxes", () => {
  it("writes positions, order and a matching colSpan, and drops legacy widths", () => {
    const slots = placeSlots({
      columns: 3,
      slots: [
        { id: "cpu", order: 0, colSpan: 1, height: null, width: 500 },
        { id: "memory", order: 1, colSpan: 1, height: 200 },
      ],
    });
    const out = slotsFromBoxes(slots, settle(boxesFor(slots, { cpu: 150 })));
    expect(out[0]).not.toHaveProperty("width");
    expect(
      out.map(({ id, order, colSpan, y }) => ({ id, order, colSpan, y })),
    ).toEqual([
      { id: "cpu", order: 0, colSpan: 1, y: 0 },
      { id: "memory", order: 1, colSpan: 1, y: 0 },
    ]);
  });
});

describe("sanitizeLayout grid positions", () => {
  it("keeps valid positions, clamps them to the grid and drops partial ones", () => {
    const layout = sanitizeLayout({
      columns: 3,
      slots: [
        { id: "cpu", colSpan: 1, x: 11, y: 40.4, w: 6 },
        { id: "memory", colSpan: 1, x: 0, y: -5, w: 1 },
        { id: "disk", colSpan: 1, x: 2, w: 4 },
      ],
    })!;
    expect(layout.slots[0]).toMatchObject({ x: 6, y: 40, w: 6 });
    expect(layout.slots[1]).toMatchObject({ x: 0, y: 0, w: 2 });
    expect(layout.slots[2]).not.toHaveProperty("x");
  });
});
