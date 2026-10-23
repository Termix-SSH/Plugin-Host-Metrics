import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import "@testing-library/jest-dom/vitest";
import { MetricCard, ManagerCardShell } from "@termix-ssh/plugin-sdk/ui";
import { HostMetricsGrid, gridRef } from "../../src/frontend/HostMetricsGrid";
import type { HostMetricsLayout } from "../../src/shared/host-metrics.js";

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

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
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => {
  document.documentElement.style.removeProperty("font-size");
  vi.unstubAllGlobals();
});
afterEach(cleanup);

const initial: HostMetricsLayout = {
  columns: 3,
  slots: [
    { id: "firewall_manager", order: 0, colSpan: 1, height: 640 },
    { id: "processes", order: 1, colSpan: 1, height: null },
  ],
};

function mount(layout = initial, editMode = true) {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState(layout);
    return (
      <HostMetricsGrid
        layout={value}
        editMode={editMode}
        cardCatalog={[{ id: "cpu", label: "Add CPU", defaultColSpan: 1 }]}
        cardLabel={(id) => id}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
        renderCard={(id) =>
          id === "firewall_manager" ? (
            <ManagerCardShell
              title={id}
              icon={null}
              loading={false}
              error={null}
              onRefresh={() => {}}
            >
              {Array.from({ length: 60 }, (_, i) => (
                <p key={i}>Rule {i}</p>
              ))}
            </ManagerCardShell>
          ) : (
            <MetricCard title={id} icon={null} scroll>
              <p>Short content</p>
            </MetricCard>
          )
        }
      />
    );
  }
  return { ...render(<Harness />), changed };
}

// jsdom has no layout: expose the SDK tile's fine-track geometry, not a mocked SDK.
function fakeGrid(container: HTMLElement) {
  const scale =
    (parseFloat(getComputedStyle(document.documentElement).fontSize) || 14) /
    14;
  const grid = container.querySelector<HTMLElement>(".grid")!;
  grid.getBoundingClientRect = () =>
    ({ width: 912, left: 0, top: 0 }) as DOMRect;
  for (const card of container.querySelectorAll<HTMLElement>(
    "[data-hm-card]",
  )) {
    const tile = card.parentElement!.parentElement!;
    card.getBoundingClientRect = () => {
      const height = card.parentElement!.style.height;
      return {
        height: height
          ? parseFloat(height) * (height.endsWith("rem") ? 14 * scale : 1)
          : 200,
      } as DOMRect;
    };
    tile.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: Number(tile.style.getPropertyValue("--hm-cols")) - 12 * scale,
        height: card.getBoundingClientRect().height,
      }) as DOMRect;
  }
  fireEvent.resize(window);
}
const widthHandle = () =>
  screen
    .getAllByRole("separator")
    .find((el) => el.getAttribute("aria-orientation") === "vertical")!;
const heightHandle = () =>
  screen
    .getAllByRole("separator")
    .find((el) => el.getAttribute("aria-orientation") === "horizontal")!;
const cornerHandle = (container: HTMLElement) =>
  container.querySelector<HTMLElement>(".hm-corner-handle")!;
const ghost = (container: HTMLElement) =>
  container.querySelector<HTMLElement>("[data-hm-resize-preview]");

describe("HostMetricsGrid", () => {
  beforeEach(() => {
    gridRef.width = 912;
  });
  it("scales stored widths with the grid so monitor changes keep proportions", () => {
    gridRef.width = 1824; // grid is half the reference: a 600 slot renders 300
    const { container } = mount({
      ...initial,
      slots: [{ ...initial.slots[0], width: 600 }],
    });
    fakeGrid(container);
    window.dispatchEvent(new Event("resize"));
    const tile = container.querySelector<HTMLElement>("[data-hm-tile]")!;
    expect(tile.style.getPropertyValue("--hm-cols")).toBe("312");
  });
  it("renders the settings minimum in CSS pixels even with a scaled root", () => {
    document.documentElement.style.fontSize = "28px";
    try {
      const { container } = mount({
        ...initial,
        slots: [{ ...initial.slots[0], width: 280 }],
      });
      fakeGrid(container);
      expect(widthHandle()).toHaveAttribute("aria-valuenow", "280");
      expect(widthHandle()).toHaveAttribute("aria-valuemin", "280");
    } finally {
      document.documentElement.style.fontSize = "14px";
    }
  });
  it("targets the SDK manager body cap only for pinned cards", () => {
    const { container } = mount(initial, false);
    const body = screen.getByText("Rule 59").parentElement!;
    const shortBody = screen.getByText("Short content").parentElement!;
    const rule = Array.from(
      container.querySelector("style")!.sheet!.cssRules,
    ).find(
      (r) =>
        r instanceof CSSStyleRule &&
        r.style.getPropertyPriority("max-height") === "important",
    ) as CSSStyleRule;
    expect(body.matches(rule.selectorText)).toBe(true);
    expect(shortBody.matches(rule.selectorText)).toBe(false);
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });

  it("previews a 73px width increase beyond the old bounds and only commits on release", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    const handle = widthHandle();
    const card = container.querySelector('[data-hm-card="firewall_manager"]')!;
    fireEvent.pointerDown(handle, { clientX: 292 });
    expect(card).toHaveAttribute("data-hm-resizing", "true");
    fireEvent.pointerMove(window, { clientX: 365 });
    expect(ghost(container)).toHaveStyle({ width: "365px", height: "640px" });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(ghost(container)).toBeNull();
    expect(card).not.toHaveAttribute("data-hm-resizing");
    expect(changed.mock.lastCall![0].slots[0]).toEqual({
      ...initial.slots[0],
      width: 365,
    });
    expect(changed.mock.lastCall![0].slots[1]).toEqual(initial.slots[1]);
    expect(
      card.parentElement!.parentElement!.style.getPropertyValue("--hm-cols"),
    ).toBe("377");
  });

  it("previews and commits height by 83px, preserving explicit width and the other slot", () => {
    const { container, changed } = mount({
      ...initial,
      slots: [{ ...initial.slots[0], width: 540 }, initial.slots[1]],
    });
    fakeGrid(container);
    fireEvent.pointerDown(heightHandle(), { clientY: 640 });
    fireEvent.pointerMove(window, { clientY: 723 });
    expect(ghost(container)).toHaveStyle({ width: "540px", height: "723px" });
    expect(changed).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(changed.mock.lastCall![0].slots[0]).toEqual({
      ...initial.slots[0],
      width: 540,
      height: 723,
    });
    expect(changed.mock.lastCall![0].slots[1]).toEqual(initial.slots[1]);
    expect(ghost(container)).toBeNull();
  });

  it("previews both dimensions in place and commits one diagonal change on release", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    const tile = container.querySelector<HTMLElement>("[data-hm-tile]")!;
    const inner =
      tile.querySelector<HTMLElement>("[data-hm-card]")!.parentElement!;
    const column = tile.style.getPropertyValue("--hm-cols");
    const row = tile.style.getPropertyValue("--hm-rows");
    const height = inner.style.height;
    fireEvent.pointerDown(cornerHandle(container), {
      clientX: 292,
      clientY: 640,
    });
    fireEvent.pointerMove(window, { clientX: 365, clientY: 723 });
    expect(ghost(container)).toHaveStyle({ width: "365px", height: "723px" });
    expect(tile.style.getPropertyValue("--hm-cols")).toBe(column);
    expect(tile.style.getPropertyValue("--hm-rows")).toBe(row);
    expect(inner.style.height).toBe(height);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.lastCall![0].slots).toEqual([
      { ...initial.slots[0], width: 365, height: 723 },
      initial.slots[1],
    ]);
    expect(ghost(container)).toBeNull();
  });

  it("clamps both corner axes to min/max and preserves the automatic width for vertical-only drags", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    const handle = cornerHandle(container);
    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: -20000, clientY: -20000 });
    expect(ghost(container)).toHaveStyle({ width: "280px", height: "80px" });
    fireEvent.pointerUp(window);
    expect(changed.mock.lastCall![0].slots[0]).toMatchObject({
      width: 280,
      height: 80,
    });
    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(window, { clientX: 20000, clientY: 20000 });
    expect(ghost(container)).toHaveStyle({ width: "900px", height: "10000px" });
    fireEvent.pointerUp(window);
    expect(changed.mock.lastCall![0].slots[0]).toMatchObject({
      width: 900,
      height: 10000,
    });
  });

  it("does not pin width when only the height changes through the corner", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    fireEvent.pointerDown(cornerHandle(container));
    fireEvent.pointerMove(window, { clientY: 83 });
    fireEvent.pointerUp(window);
    expect(changed.mock.lastCall![0].slots[0]).toEqual({
      ...initial.slots[0],
      height: 723,
    });
  });

  it("focuses the keyboard edge control after corner resizing instead of leaving a text input active", () => {
    const { container } = mount();
    fakeGrid(container);
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();
    expect(input).toHaveFocus();
    fireEvent.pointerDown(cornerHandle(container));
    expect(widthHandle()).toHaveFocus();
    fireEvent.pointerCancel(window);
  });

  it("uses fine spans rather than reserving the old column and clamps display without saving", () => {
    const { container, changed } = mount({
      ...initial,
      slots: [{ ...initial.slots[0], width: 5000 }],
    });
    fakeGrid(container);
    const tile = container.querySelector<HTMLElement>("[data-hm-tile]")!;
    expect(tile.style.getPropertyValue("--hm-cols")).toBe("912");
    expect(widthHandle()).toHaveAttribute("aria-valuenow", "900");
    fireEvent.resize(window);
    expect(changed).not.toHaveBeenCalled();
  });

  it("supports both keyboard axes, one pixel arrows, Shift ten pixels, and min/max", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    fireEvent.keyDown(widthHandle(), { key: "ArrowRight" });
    expect(changed.mock.lastCall![0].slots[0].width).toBe(293);
    fireEvent.keyDown(widthHandle(), { key: "ArrowRight", shiftKey: true });
    expect(changed.mock.lastCall![0].slots[0].width).toBe(303);
    fireEvent.keyDown(widthHandle(), { key: "End" });
    expect(changed.mock.lastCall![0].slots[0].width).toBe(900);
    fireEvent.keyDown(widthHandle(), { key: "Home" });
    expect(changed.mock.lastCall![0].slots[0].width).toBe(280);
    fireEvent.keyDown(heightHandle(), { key: "ArrowDown" });
    expect(changed.mock.lastCall![0].slots[0].height).toBe(641);
  });

  it.each(["pointercancel", "blur", "lostpointercapture", "Escape", "resize"])(
    "cleans both previews on %s without saving",
    (reason) => {
      const { container, changed } = mount();
      fakeGrid(container);
      for (const handle of [
        widthHandle(),
        heightHandle(),
        cornerHandle(container),
      ]) {
        fireEvent.pointerDown(handle, { pointerId: 1 });
        fireEvent.pointerMove(window, {
          pointerId: 2,
          clientX: 800,
          clientY: 800,
        });
        expect(changed).not.toHaveBeenCalled();
        fireEvent.pointerMove(window, {
          pointerId: 1,
          clientX: 73,
          clientY: 83,
        });
        expect(ghost(container)).not.toBeNull();
        if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
        else if (reason === "lostpointercapture")
          fireEvent.lostPointerCapture(handle, { pointerId: 1 });
        if (reason === "pointercancel")
          fireEvent.pointerCancel(window, { pointerId: 1 });
        if (reason === "blur") fireEvent.blur(window);
        if (reason === "resize") fireEvent.resize(window);
        expect(ghost(container)).toBeNull();
        expect(container.querySelector('[data-hm-resizing="true"]')).toBeNull();
        fireEvent.pointerUp(window, { pointerId: 1 });
        expect(changed).not.toHaveBeenCalled();
      }
    },
  );

  it("cleans the overlay and window listeners on unmount", () => {
    const { container, unmount, changed } = mount();
    fakeGrid(container);
    fireEvent.pointerDown(widthHandle());
    fireEvent.pointerMove(window, { clientX: 73 });
    const preview = ghost(container)!;
    const card = container.querySelector('[data-hm-card="firewall_manager"]')!;
    unmount();
    expect(preview.isConnected).toBe(false);
    expect(card).not.toHaveAttribute("data-hm-resizing");
    fireEvent.pointerUp(window);
    expect(changed).not.toHaveBeenCalled();
  });

  it("cancels an active diagonal preview when an external layout change occurs", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    fireEvent.pointerDown(cornerHandle(container));
    fireEvent.pointerMove(window, { clientX: 73, clientY: 83 });
    fireEvent.click(screen.getByText("Add CPU"));
    expect(ghost(container)).toBeNull();
    fireEvent.pointerUp(window);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.lastCall![0].slots).toHaveLength(3);
  });

  it("preserves explicit widths when adding another card with the SDK tray", () => {
    const { container, changed } = mount({
      ...initial,
      slots: [{ ...initial.slots[0], width: 573 }, initial.slots[1]],
    });
    fakeGrid(container);
    fireEvent.click(screen.getByText("Add CPU"));
    expect(changed.mock.lastCall![0].slots).toHaveLength(3);
    expect(changed.mock.lastCall![0].slots[0].width).toBe(573);
    expect(changed.mock.lastCall![0].slots[2]).toEqual({
      id: "cpu",
      order: 2,
      colSpan: 1,
      height: null,
    });
  });

  it("converts height through the SDK root scale without scaling saved CSS-pixel width", () => {
    document.documentElement.style.fontSize = "28px";
    try {
      const { container, changed } = mount({
        ...initial,
        slots: [{ ...initial.slots[0], width: 700 }],
      });
      fakeGrid(container);
      expect(widthHandle()).toHaveAttribute("aria-valuenow", "700");
      fireEvent.pointerDown(cornerHandle(container), { clientY: 1280 });
      fireEvent.pointerMove(window, { clientX: 70, clientY: 1364 });
      expect(ghost(container)).toHaveStyle({
        width: "770px",
        height: "1364px",
      });
      fireEvent.pointerUp(window);
      expect(changed.mock.lastCall![0].slots[0]).toEqual({
        ...initial.slots[0],
        height: 682,
        width: 770,
      });
    } finally {
      document.documentElement.style.fontSize = "14px";
    }
  });

  it("hides only the SDK width button, retaining remove/reorder and keyboard resizing", () => {
    const { container, changed } = mount({
      ...initial,
      slots: [{ ...initial.slots[0], width: 500 }, initial.slots[1]],
    });
    fakeGrid(container);
    const widthButton = container.querySelector(
      '[title="cardGrid.changeWidth"]',
    )!;
    expect(widthButton).not.toBeVisible();
    expect(
      container.querySelector('[title="cardGrid.removeCard"]'),
    ).toBeVisible();
    fireEvent.keyDown(widthHandle(), { key: "ArrowRight" });
    expect(changed.mock.lastCall![0].slots[0].width).toBe(501);
    const tiles = container.querySelectorAll(".grid > div");
    fireEvent.dragStart(tiles[1]);
    fireEvent.drop(tiles[0]);
    expect(changed.mock.lastCall![0].slots[0].id).toBe("processes");
    fireEvent.click(container.querySelector('[title="cardGrid.removeCard"]')!);
    expect(changed.mock.lastCall![0].slots).toHaveLength(1);
  });
  it("resizes from the left with the inverse delta and cleans cancellation", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    const left = container.querySelector(".hm-left-handle")!;
    fireEvent.pointerDown(left, { clientX: 100 });
    expect(widthHandle()).toHaveFocus();
    fireEvent.pointerMove(window, { clientX: 27 });
    expect(ghost(container)).toHaveStyle({ width: "365px" });
    fireEvent.pointerUp(window);
    expect(changed.mock.lastCall![0].slots[0].width).toBe(365);
    fireEvent.pointerDown(left);
    fireEvent.pointerMove(window, { clientX: -80 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(ghost(container)).toBeNull();
    fireEvent.pointerUp(window);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("snaps predicted edges to an offset unequal card, not just its width", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    const target = container.querySelector<HTMLElement>(
      '[data-hm-tile="processes"]',
    )!;
    target.getBoundingClientRect = () =>
      ({ left: 312, top: 800, width: 500, height: 200 }) as DOMRect;
    fireEvent.pointerDown(widthHandle());
    fireEvent.pointerMove(window, { clientX: 514 });
    expect(ghost(container)).toHaveStyle({ left: "0px", width: "812px" });
    expect(
      container.querySelector('[data-hm-snap-guide][data-axis="x"]'),
    ).toBeVisible();
    expect(
      container.querySelector('[data-hm-snap-guide][data-axis="x"]'),
    ).toHaveStyle({ left: "812px" });
    fireEvent.pointerUp(window);
    expect(container.querySelector("[data-hm-snap-guide]")).toBeNull();
    expect(changed.mock.lastCall![0].slots[0].width).toBe(812);
    fireEvent.pointerDown(heightHandle());
    fireEvent.pointerMove(window, { clientY: 354 });
    expect(ghost(container)).toHaveStyle({ height: "1000px" });
    expect(
      container.querySelector('[data-hm-snap-guide][data-axis="y"]'),
    ).toBeVisible();
    expect(
      container.querySelector('[data-hm-snap-guide][data-axis="y"]'),
    ).toHaveStyle({ top: "1000px" });
    fireEvent.pointerUp(window);
    expect(container.querySelector("[data-hm-snap-guide]")).toBeNull();
    expect(changed.mock.lastCall![0].slots[0].height).toBe(1000);
  });

  it("previews unequal cards without reparenting live nodes even on repeated dragover", () => {
    const { container, changed, unmount } = mount({
      ...initial,
      slots: [
        { ...initial.slots[0], width: 600 },
        { ...initial.slots[1], width: 292 },
      ],
    });
    fakeGrid(container);
    const grid = container.querySelector<HTMLElement>("[data-hm-grid]")!;
    const tiles = Array.from(grid.children) as HTMLElement[];
    for (const tile of tiles)
      tile.getBoundingClientRect = () => {
        const before = Array.from(grid.children).slice(
          0,
          Array.from(grid.children).indexOf(tile),
        ) as HTMLElement[];
        return {
          left: before.reduce(
            (sum, item) =>
              sum + Number(item.style.getPropertyValue("--hm-cols")),
            0,
          ),
          top: 0,
          width: Number(tile.style.getPropertyValue("--hm-cols")) - 12,
          height: 200,
        } as DOMRect;
      };
    const append = vi.spyOn(grid, "appendChild");
    fireEvent.dragStart(tiles[1]);
    fireEvent.dragOver(tiles[0]);
    for (let i = 0; i < 100; i++) fireEvent.dragOver(tiles[0]);
    expect(append).not.toHaveBeenCalled();
    const preview = container.querySelector<HTMLElement>(
      "[data-hm-drop-preview]",
    )!;
    expect(preview).toHaveStyle({
      left: "0px",
      width: "292px",
      height: "200px",
    });
    expect(Array.from(grid.children)).toEqual(tiles);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.drop(tiles[0]);
    expect(preview.isConnected).toBe(false);
    expect(
      changed.mock.lastCall![0].slots.map((slot: { id: string }) => slot.id),
    ).toEqual(["processes", "firewall_manager"]);
    fireEvent.dragStart(tiles[0]);
    fireEvent.dragOver(tiles[1]);
    unmount();
    expect(container.querySelector("[data-hm-drop-preview]")).toBeNull();
  });

  it("previews the SDK trailing drop zone and clears it on Escape", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    const grid = container.querySelector<HTMLElement>("[data-hm-grid]")!;
    fireEvent.dragStart(grid.firstElementChild!);
    const trailing = grid.parentElement!.lastElementChild!;
    expect(trailing).not.toBe(grid);
    fireEvent.dragOver(trailing);
    expect(container.querySelector("[data-hm-drop-preview]")).not.toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(container.querySelector("[data-hm-drop-preview]")).toBeNull();
    fireEvent.dragEnd(grid.firstElementChild!);
    expect(changed).not.toHaveBeenCalled();
  });

  it("does not snap on a click or accept a snap that wraps away from the target edge", () => {
    const { container, changed } = mount();
    fakeGrid(container);
    const source = container.querySelector<HTMLElement>(
      '[data-hm-tile="firewall_manager"]',
    )!;
    const target = container.querySelector<HTMLElement>(
      '[data-hm-tile="processes"]',
    )!;
    source.getBoundingClientRect = () => {
      const width = Number(source.style.getPropertyValue("--hm-cols")) - 12;
      return {
        left: width <= 504 ? 144 : 0,
        top: 0,
        width,
        height: 640,
      } as DOMRect;
    };
    target.getBoundingClientRect = () =>
      ({ left: 312, top: 800, width: 338, height: 200 }) as DOMRect;
    fireEvent.pointerDown(widthHandle());
    fireEvent.pointerUp(window);
    expect(changed).not.toHaveBeenCalled();
    fireEvent.pointerDown(widthHandle());
    fireEvent.pointerMove(window, { clientX: 208 });
    expect(ghost(container)).toHaveStyle({ left: "144px", width: "500px" });
    fireEvent.pointerUp(window);
    expect(changed.mock.lastCall![0].slots[0].width).toBe(500);
  });
});
