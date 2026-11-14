import { describe, expect, it } from "vitest";
import { checkFrameApp } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";

describe("sandboxed frame", () => {
  it("registers nothing the shell can't take from a frame", async () => {
    const { problems, registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    expect(problems).toEqual([]);
    expect(registrations.length).toBeGreaterThan(0);
  });
});

describe("per host pieces", () => {
  it("sends row, badge, homepage and terminal readouts as data, not frames", async () => {
    const { registrations } = await checkFrameApp(plugin, {
      manifest: manifest as unknown as Record<string, unknown>,
    });
    const slots = registrations
      .filter((entry) => entry.kind === "slotContribution")
      .map((entry) => entry.data as Record<string, unknown>);
    for (const slotId of [
      "dashboard.hostRow",
      "dashboard.hostRowBadge",
      "homepage.hostMetrics",
      "terminal.toolbarStatus",
    ]) {
      const entry = slots.find((data) => data.slotId === slotId);
      expect(entry, slotId).toMatchObject({ kind: "data" });
      expect(entry?.valueKey, slotId).toBe(
        `data:${slotId}:${String(entry?.actionId)}`,
      );
      expect(entry?.component, slotId).toBeUndefined();
    }
  });
});
