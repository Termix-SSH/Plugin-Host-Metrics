import { describe, expect, it } from "vitest";
import { liveCmd, parseLive } from "../../../src/backend/managers/live-swap.js";
import { liveCmd as sdkLiveCmd } from "@termix-ssh/plugin-sdk/host-scripts";

const frame = (memory: string) =>
  [
    "cpu 10 0 0 90",
    `MemTotal: 1000 kB\nMemAvailable: 400 kB\n${memory}`,
    "0.1 0.2 0.3\n100 5",
    "Inter-|",
    "4096",
    "",
  ].join("\n@@\n");

describe("live swap", () => {
  it("reuses the SDK single-awk command, without an extra SSH command", () => {
    expect(liveCmd(4096)).toBe(sdkLiveCmd(4096));
    expect(liveCmd()).toContain("SwapTotal|SwapFree");
  });
  it("adds validated swap to the live sample without changing CPU/memory", () => {
    const parsed = parseLive(
      frame("SwapTotal: 1000 kB\nSwapFree: 750 kB"),
      undefined,
    );
    expect(parsed.sample.swap).toEqual({
      totalBytes: 1024000,
      freeBytes: 768000,
      usedBytes: 256000,
      percent: 25,
    });
    expect(parsed.sample.memTotalKb).toBe(1000);
    expect(parsed.sample.memUsedKb).toBe(600);
  });
  it("keeps no-swap readings distinct from unavailable fields", () => {
    expect(
      parseLive(frame("SwapTotal: 0 kB\nSwapFree: 0 kB"), undefined).sample.swap
        ?.percent,
    ).toBeNull();
    expect(parseLive(frame(""), undefined).sample.swap).toBeUndefined();
  });
  it("rejects corrupt swap fields rather than reporting false zero usage", () => {
    expect(() =>
      parseLive(frame("SwapTotal: 100 kB\nSwapFree: 101 kB"), undefined),
    ).toThrow();
  });
});
