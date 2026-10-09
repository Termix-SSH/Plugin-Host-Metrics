import { describe, expect, it } from "vitest";
import {
  hostHasMetrics,
  metricsEnabledFor,
} from "../../src/frontend/host-filter";

describe("host filter", () => {
  it("skips hosts without SSH or with metrics turned off", () => {
    expect(hostHasMetrics({ enableSsh: false })).toBe(false);
    expect(
      hostHasMetrics({
        enableSsh: true,
        pluginSettings: { "host-metrics": { metricsEnabled: false } },
      }),
    ).toBe(false);
  });

  it("keeps SSH hosts and callers that pass no host", () => {
    expect(hostHasMetrics({ enableSsh: true })).toBe(true);
    expect(hostHasMetrics(undefined)).toBe(true);
    expect(metricsEnabledFor({})).toBe(true);
  });
});
