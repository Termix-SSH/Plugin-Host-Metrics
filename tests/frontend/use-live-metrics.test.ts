import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const managerGet = vi.hoisted(() => vi.fn());
vi.mock("../../src/frontend/host-metrics-api", () => ({
  useHostMetricsApi: () => ({ managerGet }),
}));
import { useLiveMetrics } from "../../src/frontend/live-metrics";

const sample = { cpu: 1, minIntervalS: 0 } as never;
const disabled = { response: { data: { code: "LIVE_DISABLED" } } };
const tick = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

afterEach(() => {
  vi.useRealTimers();
  managerGet.mockReset();
});

describe("useLiveMetrics", () => {
  it("clears the previous host sample and ignores its delayed reply", async () => {
    vi.useFakeTimers();
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    managerGet
      .mockResolvedValueOnce(sample)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveNew = resolve;
          }),
      );
    const { result, rerender, unmount } = renderHook(
      ({ hostId }) => useLiveMetrics(hostId, true, 1000),
      { initialProps: { hostId: 1 } },
    );
    await tick(0);
    expect(result.current).toBe(sample);
    await tick(1000);
    rerender({ hostId: 2 });
    expect(result.current).toBeNull();
    await act(async () => resolveOld({ cpu: 99 }));
    expect(result.current).toBeNull();
    const next = { cpu: 2, minIntervalS: 0 };
    await act(async () => resolveNew(next));
    expect(result.current).toBe(next);
    unmount();
  });

  it("recovers after live updates are disabled and re-enabled, without a remount", async () => {
    vi.useFakeTimers();
    managerGet.mockRejectedValueOnce(disabled).mockResolvedValue(sample);
    const { result } = renderHook(() => useLiveMetrics(1, true, 2000));
    await tick(0);
    expect(result.current).toBeNull();
    await tick(29_000);
    expect(managerGet).toHaveBeenCalledTimes(1);
    await tick(2000);
    expect(managerGet).toHaveBeenCalledTimes(2);
    expect(result.current).toBe(sample);
  });

  it("slows to the admin minimum and stops polling when inactive or unmounted", async () => {
    vi.useFakeTimers();
    managerGet.mockResolvedValue({ cpu: 1, minIntervalS: 5 });
    const { unmount, rerender } = renderHook(
      ({ active }) => useLiveMetrics(1, active, 1000),
      { initialProps: { active: true } },
    );
    await tick(0);
    await tick(4000);
    expect(managerGet).toHaveBeenCalledTimes(1);
    await tick(1000);
    expect(managerGet).toHaveBeenCalledTimes(2);
    rerender({ active: false });
    await tick(20_000);
    expect(managerGet).toHaveBeenCalledTimes(2);
    unmount();
  });
});
