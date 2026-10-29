import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { HostMetricsGrid } from "../../src/frontend/HostMetricsGrid";
import type { HostMetricsLayout } from "../../src/shared/host-metrics.js";

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// 1212px wide grid: one column is (1212 + 12) / 12 = 102px.
let gridWidth = 1212;
const PITCH = 102;
const original = HTMLElement.prototype.getBoundingClientRect;

beforeAll(() => {
  document.documentElement.style.fontSize = "14px";
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    },
  );
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    if (this.dataset.hmCard) return { height: 200, width: 0 } as DOMRect;
    return {
      left: 0,
      top: 0,
      width: gridWidth,
      height: 0,
      right: gridWidth,
      bottom: 0,
    } as DOMRect;
  };
});
afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = original;
  document.documentElement.style.removeProperty("font-size");
  vi.unstubAllGlobals();
});
beforeEach(() => {
  gridWidth = 1212;
});
afterEach(cleanup);

const three: HostMetricsLayout = {
  columns: 3,
  slots: [
    { id: "cpu", order: 0, colSpan: 1, height: null },
    { id: "memory", order: 1, colSpan: 1, height: null },
    { id: "disk", order: 2, colSpan: 1, height: null },
  ],
};

function mount(layout = three, editMode = true) {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState(layout);
    return (
      <HostMetricsGrid
        layout={value}
        editMode={editMode}
        cardCatalog={[
          { id: "cpu", label: "CPU" },
          { id: "gpu", label: "GPU", defaultColSpan: 2 },
        ]}
        cardLabel={(id) => id}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
        renderCard={(id) => <div data-testid={`body-${id}`}>{id}</div>}
      />
    );
  }
  return { ...render(<Harness />), changed };
}

const tile = (id: string) =>
  document.querySelector<HTMLElement>(`[data-hm-tile="${id}"]`)!;
const position = (element: HTMLElement) => {
  const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(
    element.style.transform,
  )!;
  return { x: Number(match[1]), y: Number(match[2]) };
};
const pointer = (
  target: Element | Window,
  type: "pointerDown" | "pointerMove" | "pointerUp",
  x: number,
  y: number,
) =>
  fireEvent[type](target, { clientX: x, clientY: y, button: 0, pointerId: 1 });
const slot = (layout: HostMetricsLayout, id: string) =>
  layout.slots.find((s) => s.id === id)!;

describe("HostMetricsGrid", () => {
  it("places legacy layouts on the 12 column grid", () => {
    mount();
    expect(position(tile("cpu"))).toEqual({ x: 0, y: 0 });
    expect(position(tile("memory"))).toEqual({ x: 4 * PITCH, y: 0 });
    expect(position(tile("disk"))).toEqual({ x: 8 * PITCH, y: 0 });
    expect(tile("cpu").style.width).toBe(`${4 * PITCH - 12}px`);
  });

  it("drops a dragged card exactly where the preview showed it", () => {
    const { changed } = mount();
    pointer(screen.getByTestId("body-cpu"), "pointerDown", 10, 10);
    pointer(window, "pointerMove", 10 + 4 * PITCH, 300);
    const ghost = document.querySelector<HTMLElement>(
      "[data-hm-drop-preview]",
    )!;
    const previewed = position(ghost);
    expect(previewed).toEqual({ x: 4 * PITCH, y: 212 });
    expect(position(tile("memory"))).toEqual({ x: 4 * PITCH, y: 0 });
    expect(position(tile("disk"))).toEqual({ x: 8 * PITCH, y: 0 });
    pointer(window, "pointerUp", 10 + 4 * PITCH, 300);
    const next = changed.mock.calls[0][0] as HostMetricsLayout;
    expect(slot(next, "cpu")).toMatchObject({ x: 4, y: 212 });
    expect(position(tile("cpu"))).toEqual(previewed);
    expect(slot(next, "memory")).toMatchObject({ x: 4, y: 0 });
    expect(slot(next, "disk")).toMatchObject({ x: 8, y: 0 });
  });

  it("moves a card into another column without touching the rest", () => {
    const layout: HostMetricsLayout = {
      columns: 3,
      slots: [
        { id: "cpu", order: 0, colSpan: 1, height: null },
        { id: "memory", order: 1, colSpan: 1, height: null },
      ],
    };
    const { changed } = mount(layout);
    pointer(screen.getByTestId("body-cpu"), "pointerDown", 10, 10);
    pointer(window, "pointerMove", 10 + 8 * PITCH, 10);
    pointer(window, "pointerUp", 10 + 8 * PITCH, 10);
    const next = changed.mock.calls[0][0] as HostMetricsLayout;
    expect(slot(next, "cpu")).toMatchObject({ x: 8, y: 0 });
    expect(slot(next, "memory")).toMatchObject({ x: 4, y: 0 });
  });

  it("does nothing on a click without movement", () => {
    const { changed } = mount();
    pointer(screen.getByTestId("body-cpu"), "pointerDown", 10, 10);
    pointer(window, "pointerMove", 12, 11);
    pointer(window, "pointerUp", 12, 11);
    expect(changed).not.toHaveBeenCalled();
  });

  it("only pushes the overlapping card when a card gets wider", () => {
    const { changed } = mount();
    const edge = tile("cpu").querySelector(".hm-edge-right")!;
    pointer(edge, "pointerDown", 400, 100);
    pointer(window, "pointerMove", 400 + 2 * PITCH, 100);
    expect(tile("cpu").dataset.active).toBe("resize");
    pointer(window, "pointerUp", 400 + 2 * PITCH, 100);
    const next = changed.mock.calls[0][0] as HostMetricsLayout;
    expect(slot(next, "cpu")).toMatchObject({ x: 0, y: 0, w: 6 });
    expect(slot(next, "memory")).toMatchObject({ x: 4, y: 212 });
    expect(slot(next, "disk")).toMatchObject({ x: 8, y: 0, w: 4 });
  });

  it("resizes from the left edge keeping the right side in place", () => {
    const { changed } = mount();
    const edge = tile("disk").querySelector(".hm-edge-left")!;
    pointer(edge, "pointerDown", 8 * PITCH, 100);
    pointer(window, "pointerMove", 8 * PITCH + 2 * PITCH, 100);
    pointer(window, "pointerUp", 8 * PITCH + 2 * PITCH, 100);
    const next = changed.mock.calls[0][0] as HostMetricsLayout;
    expect(slot(next, "disk")).toMatchObject({ x: 10, w: 2 });
  });

  it("pins the height and snaps to a neighbour's bottom", () => {
    const layout: HostMetricsLayout = {
      columns: 3,
      slots: [
        { id: "cpu", order: 0, colSpan: 1, height: null },
        { id: "memory", order: 1, colSpan: 1, height: 300 },
      ],
    };
    const { changed } = mount(layout);
    const edge = tile("memory").querySelector(".hm-edge-bottom")!;
    pointer(edge, "pointerDown", 500, 300);
    pointer(window, "pointerMove", 500, 196);
    pointer(window, "pointerUp", 500, 196);
    const next = changed.mock.calls[0][0] as HostMetricsLayout;
    expect(slot(next, "memory").height).toBe(200);
  });

  it("cancels on Escape without saving", () => {
    const { changed } = mount();
    pointer(screen.getByTestId("body-cpu"), "pointerDown", 10, 10);
    pointer(window, "pointerMove", 10, 300);
    fireEvent.keyDown(window, { key: "Escape" });
    pointer(window, "pointerUp", 10, 300);
    expect(changed).not.toHaveBeenCalled();
    expect(document.querySelector("[data-hm-drop-preview]")).toBeNull();
    expect(position(tile("cpu"))).toEqual({ x: 0, y: 0 });
  });

  it("resizes and moves with the keyboard", () => {
    const { changed } = mount();
    const width = tile("disk").querySelector('[aria-orientation="vertical"]')!;
    fireEvent.keyDown(width, { key: "ArrowLeft" });
    expect(slot(changed.mock.calls[0][0], "disk").w).toBe(3);
    const grip = tile("cpu").querySelector("[data-hm-grip]")!;
    fireEvent.keyDown(grip, { key: "ArrowRight" });
    expect(slot(changed.mock.calls[1][0], "cpu").x).toBe(1);
    expect(slot(changed.mock.calls[1][0], "memory")).toMatchObject({ y: 212 });
  });

  it("adds a card at the bottom and removes cards", () => {
    const { changed } = mount();
    fireEvent.click(screen.getByText("GPU"));
    const added = slot(changed.mock.calls[0][0], "gpu");
    expect(added).toMatchObject({ x: 0, y: 212, w: 8 });
    fireEvent.click(screen.getAllByLabelText("hostMetrics.grid.removeCard")[0]);
    expect(changed.mock.calls[1][0].slots).toHaveLength(3);
  });

  it("stacks cards with no edit controls on narrow screens", () => {
    gridWidth = 500;
    mount();
    expect(document.querySelector("[data-hm-tile]")).toBeNull();
    expect(screen.getByTestId("body-disk")).toBeInTheDocument();
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
  });

  it("shows no edit controls outside edit mode", () => {
    mount(three, false);
    expect(screen.queryAllByRole("separator")).toHaveLength(0);
    pointer(screen.getByTestId("body-cpu"), "pointerDown", 10, 10);
    expect(document.querySelector("[data-active]")).toBeNull();
  });
});
