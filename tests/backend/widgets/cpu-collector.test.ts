import { describe, it, expect } from "vitest";
import { parseDarwinCpuUsageLine } from "../../../src/backend/widgets/cpu-collector.js";

describe("parseDarwinCpuUsageLine", () => {
  it("parses macOS `top -l 1` CPU usage line", () => {
    const result = parseDarwinCpuUsageLine(
      "CPU usage: 12.34% user, 5.66% sys, 82.00% idle",
    );
    expect(result?.percent).toBeCloseTo(18.0, 5);
  });

  it("returns undefined for unrelated lines", () => {
    expect(parseDarwinCpuUsageLine("Processes: 400 total")).toBeUndefined();
  });
});
