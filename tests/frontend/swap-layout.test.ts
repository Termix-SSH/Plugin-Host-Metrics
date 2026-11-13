import { describe, expect, it } from "vitest";
import {
  CARD_SETTINGS,
  defaultLayoutFromWidgets,
  deriveEnabledWidgets,
  sanitizeLayout,
} from "../../src/shared/host-metrics.js";
import { readHostMetricsSettings } from "../../src/shared/stats-widgets.js";

describe("swap layout", () => {
  it("supports adding, saving and deriving the swap widget", () => {
    const layout = defaultLayoutFromWidgets(["cpu", "memory", "swap"]);
    expect(layout.slots.map((slot) => slot.id)).toEqual([
      "cpu",
      "memory",
      "swap",
    ]);
    expect(sanitizeLayout(layout)).toEqual(layout);
    expect(deriveEnabledWidgets(layout.slots)).toEqual([
      "cpu",
      "memory",
      "swap",
    ]);
    expect(CARD_SETTINGS.swap).toEqual(["chartSize", "showDetails"]);
  });

  it("does not inject swap into existing defaults or saved widget choices", () => {
    expect(readHostMetricsSettings({}).enabledWidgets).not.toContain("swap");
    expect(
      defaultLayoutFromWidgets(["cpu", "memory"]).slots.map((slot) => slot.id),
    ).toEqual(["cpu", "memory"]);
  });
});
