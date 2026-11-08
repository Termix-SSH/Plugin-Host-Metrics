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
import type { HostMetricsLayout } from "../../src/shared/host-metrics.js";

// The grid itself is core's and tested there; this checks the mapping.
const grid = vi.hoisted(() => ({
  props: null as null | {
    slots: { id: string; x: number; y: number; w: number; h?: number | null }[];
    onChange: (slots: unknown[]) => void;
    onSettings?: (id: string) => void;
  },
}));

vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  TileGrid: (props: typeof grid.props) => {
    grid.props = props;
    return (
      <div>
        {props!.slots.map((slot) => (
          <div key={slot.id} data-testid={`tile-${slot.id}`} />
        ))}
      </div>
    );
  },
  TilePicker: ({
    entries,
    onAdd,
  }: {
    entries: { id: string; title: string; placed?: boolean }[];
    onAdd: (entry: { id: string }) => void;
  }) => (
    <div>
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          disabled={entry.placed}
          onClick={() => onAdd(entry)}
        >
          {entry.title}
        </button>
      ))}
    </div>
  ),
  appendTile: (
    slots: { id: string }[],
    tile: { id: string; w?: number; h?: number | null },
  ) => [
    ...slots,
    { id: tile.id, x: 0, y: 1_000_000, w: tile.w ?? 4, h: tile.h ?? null },
  ],
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { HostMetricsGrid } from "../../src/frontend/HostMetricsGrid";

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterAll(() => vi.unstubAllGlobals());
afterEach(() => {
  cleanup();
  grid.props = null;
});

const three: HostMetricsLayout = {
  columns: 3,
  slots: [
    {
      id: "cpu",
      order: 0,
      colSpan: 1,
      height: null,
      settings: { showHardware: true },
    },
    { id: "memory", order: 1, colSpan: 1, height: 300 },
    { id: "disk", order: 2, colSpan: 1, height: null },
  ],
};

function mount(layout = three) {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState(layout);
    return (
      <HostMetricsGrid
        layout={value}
        editMode
        cardCatalog={[
          { id: "cpu", label: "CPU" },
          { id: "gpu", label: "GPU", defaultColSpan: 2, defaultHeight: 250 },
        ]}
        cardLabel={(id) => id}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
        renderCard={(id) => <div>{id}</div>}
      />
    );
  }
  return { ...render(<Harness />), changed };
}

describe("HostMetricsGrid", () => {
  it("places legacy layouts on the 12 column grid", () => {
    mount();
    expect(grid.props!.slots).toEqual([
      { id: "cpu", x: 0, y: 0, w: 4, h: null },
      { id: "memory", x: 4, y: 0, w: 4, h: 300 },
      { id: "disk", x: 8, y: 0, w: 4, h: null },
    ]);
  });

  it("writes moves back keeping each card's own fields", () => {
    const { changed } = mount();
    grid.props!.onChange([
      { id: "memory", x: 0, y: 0, w: 6, h: 200 },
      { id: "cpu", x: 6, y: 0, w: 6, h: null },
    ]);
    const next = changed.mock.calls[0][0] as HostMetricsLayout;
    expect(next.columns).toBe(3);
    expect(next.slots).toEqual([
      expect.objectContaining({
        id: "memory",
        x: 0,
        w: 6,
        height: 200,
        order: 0,
        colSpan: 2,
      }),
      expect.objectContaining({
        id: "cpu",
        x: 6,
        w: 6,
        settings: { showHardware: true },
        order: 1,
      }),
    ]);
  });

  it("adds a card from the list at its default size", () => {
    const { changed } = mount();
    expect(screen.getByText("CPU")).toBeDisabled();
    fireEvent.click(screen.getByText("GPU"));
    const next = changed.mock.calls[0][0] as HostMetricsLayout;
    expect(next.slots.find((slot) => slot.id === "gpu")).toMatchObject({
      x: 0,
      w: 8,
      height: 250,
    });
    expect(next.slots).toHaveLength(4);
  });
});
