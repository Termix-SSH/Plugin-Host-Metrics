import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  tweenLast,
  useSmoothSeries,
} from "../../src/frontend/cards/SmoothCharts";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useSmoothSeries", () => {
  it("animates updates, settles exactly, and cancels on unmount", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) =>
      setTimeout(() => fn(performance.now()), 16),
    );
    vi.stubGlobal("cancelAnimationFrame", clearTimeout);
    const { result, rerender, unmount } = renderHook(
      ({ rows }) => useSmoothSeries(rows),
      { initialProps: { rows: [[1, 2]] } },
    );
    expect(vi.getTimerCount()).toBe(0);
    rerender({ rows: [[2, 10]] });
    expect(result.current).toEqual([[2, 2]]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current[0][1]).toBeGreaterThan(2);
    expect(result.current[0][1]).toBeLessThan(10);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toEqual([[2, 10]]);
    expect(vi.getTimerCount()).toBe(0);
    rerender({ rows: [[10, 50]] });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honours reduced motion without scheduling animation", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    const { result, rerender } = renderHook(
      ({ rows }) => useSmoothSeries(rows),
      { initialProps: { rows: [[1]] } },
    );
    rerender({ rows: [[10]] });
    expect(result.current).toEqual([[10]]);
  });
  it("shares a frame request across charts", () => {
    const raf = vi.fn(() => 1);
    vi.stubGlobal("requestAnimationFrame", raf);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { rerender, unmount } = renderHook(
      ({ value }) => [
        useSmoothSeries([[value]]),
        useSmoothSeries([[value * 2]]),
      ],
      { initialProps: { value: 1 } },
    );
    rerender({ value: 10 });
    expect(raf).toHaveBeenCalledTimes(1);
    unmount();
  });
});

describe("tweenLast", () => {
  it("moves only the newest point between the old and new value", () => {
    const [row] = tweenLast([[1, 2, 10]], [2], 0.5);
    expect(row.slice(0, 2)).toEqual([1, 2]);
    expect(row[2]).toBeGreaterThan(2);
    expect(row[2]).toBeLessThan(10);
  });
  it("leaves gaps and finished animations untouched", () => {
    expect(tweenLast([[1, null]], [5], 0.5)).toEqual([[1, null]]);
    expect(tweenLast([[1, 9]], [5], 1)).toEqual([[1, 9]]);
    expect(tweenLast([[1, 9]], [null], 0.5)).toEqual([[1, 9]]);
  });
});
