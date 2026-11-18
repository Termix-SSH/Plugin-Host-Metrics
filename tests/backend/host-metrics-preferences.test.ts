import { describe, it, expect } from "vitest";
import {
  deriveEnabledWidgets,
  defaultLayoutFromWidgets,
  isMetricCardId,
  isManagerCardId,
  METRIC_CARD_IDS,
} from "../../src/shared/host-metrics.js";

describe("deriveEnabledWidgets", () => {
  it("returns only metric ids, in canonical order, deduped", () => {
    const slots = [
      { id: "firewall" },
      { id: "cpu" },
      { id: "cpu" },
      { id: "memory" },
    ];
    expect(deriveEnabledWidgets(slots)).toEqual(["cpu", "memory", "firewall"]);
  });

  it("excludes manager card ids (mobile contract: never leak managers)", () => {
    const slots = [
      { id: "cpu" },
      { id: "service_manager" },
      { id: "log_viewer" },
      { id: "disk" },
    ];
    const out = deriveEnabledWidgets(slots);
    expect(out).toEqual(["cpu", "disk"]);
    for (const id of out) expect(isMetricCardId(id)).toBe(true);
  });

  it("output is always a subset of the 10 known WidgetTypes", () => {
    const slots = METRIC_CARD_IDS.map((id) => ({ id })).concat([
      { id: "user_manager" } as unknown as {
        id: (typeof METRIC_CARD_IDS)[number];
      },
      { id: "bogus" } as unknown as { id: (typeof METRIC_CARD_IDS)[number] },
    ]);
    const out = deriveEnabledWidgets(slots);
    expect(out).toEqual(METRIC_CARD_IDS);
    expect(out.length).toBe(METRIC_CARD_IDS.length);
  });

  it("empty slots -> empty widgets", () => {
    expect(deriveEnabledWidgets([])).toEqual([]);
  });
});

describe("defaultLayoutFromWidgets", () => {
  it("builds slots in canonical order with dense ordering", () => {
    const layout = defaultLayoutFromWidgets(["disk", "cpu", "memory"]);
    expect(layout.slots.map((s) => s.id)).toEqual(["cpu", "memory", "disk"]);
    expect(layout.slots.map((s) => s.order)).toEqual([0, 1, 2]);
    expect(layout.columns).toBe(3);
  });

  it("lays every row across all 12 columns at one height", () => {
    const layout = defaultLayoutFromWidgets([...METRIC_CARD_IDS]);
    const rows = new Map<number, typeof layout.slots>();
    for (const slot of layout.slots)
      rows.set(slot.y!, [...(rows.get(slot.y!) ?? []), slot]);
    for (const row of rows.values()) {
      expect(row.reduce((sum, slot) => sum + slot.w!, 0)).toBe(12);
      expect(new Set(row.map((slot) => slot.height)).size).toBe(1);
    }
    expect(rows.size).toBe(6);
  });

  it("widens the rest of a row when a card is off", () => {
    const layout = defaultLayoutFromWidgets(["cpu", "disk", "uptime"]);
    expect(layout.slots.map((s) => [s.id, s.x, s.w])).toEqual([
      ["cpu", 0, 6],
      ["disk", 6, 6],
      ["uptime", 0, 12],
    ]);
  });

  it("ignores unknown widget ids", () => {
    const layout = defaultLayoutFromWidgets(["cpu", "nope", "service_manager"]);
    expect(layout.slots.map((s) => s.id)).toEqual(["cpu"]);
  });

  it("assigns valid colSpans (1..3)", () => {
    const layout = defaultLayoutFromWidgets([...METRIC_CARD_IDS]);
    for (const s of layout.slots) {
      expect([1, 2, 3]).toContain(s.colSpan);
    }
  });

  it("keeps the opt-in gpu card when deriving enabledWidgets", () => {
    expect(deriveEnabledWidgets([{ id: "gpu" }, { id: "cpu" }])).toEqual([
      "cpu",
      "gpu",
    ]);
  });

  it("round-trips: deriveEnabledWidgets(defaultLayout) === input order", () => {
    const layout = defaultLayoutFromWidgets(["ports", "cpu", "firewall"]);
    expect(deriveEnabledWidgets(layout.slots)).toEqual([
      "cpu",
      "ports",
      "firewall",
    ]);
  });
});

describe("card id guards", () => {
  it("classifies metric vs manager ids", () => {
    expect(isMetricCardId("cpu")).toBe(true);
    expect(isMetricCardId("service_manager")).toBe(false);
    expect(isManagerCardId("service_manager")).toBe(true);
    expect(isManagerCardId("cpu")).toBe(false);
  });
});
