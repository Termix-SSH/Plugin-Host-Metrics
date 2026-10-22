import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHostMetricsPreferences } from "../../src/frontend/hooks/useHostMetricsPreferences";
import type { HostMetricsLayout } from "../../src/shared/host-metrics.js";

const api = vi.hoisted(() => ({
  getHostMetricsLayout: vi.fn(),
  saveHostMetricsLayout: vi.fn(),
  applyLayoutTemplate: vi.fn(),
}));
vi.mock("../../src/frontend/host-metrics-api", () => ({
  useHostMetricsApi: () => api,
}));

const layout: HostMetricsLayout = {
  columns: 3,
  slots: [
    { id: "firewall_manager", order: 0, colSpan: 3, height: 720, width: 573 },
  ],
};
const defaults: HostMetricsLayout = {
  columns: 3,
  slots: [
    { id: "cpu", order: 0, colSpan: 1, height: null },
    { id: "memory", order: 1, colSpan: 1, height: null },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  localStorage.clear();
  api.getHostMetricsLayout.mockResolvedValue(null);
  api.saveHostMetricsLayout.mockResolvedValue(undefined);
  api.applyLayoutTemplate.mockResolvedValue([{ hostId: 7, applied: true }]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("layout size persistence", () => {
  it("caches both dimensions immediately and debounces the existing backend save", async () => {
    const { result, unmount } = renderHook(() =>
      useHostMetricsPreferences(7, defaults),
    );
    await act(async () => {});
    act(() => result.current.setLayout(layout));
    const latest = { ...layout, slots: [{ ...layout.slots[0], height: 800 }] };
    act(() => result.current.setLayout(latest));
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:7")!)).toEqual(
      latest,
    );
    expect(api.saveHostMetricsLayout).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(
      7,
      latest,
    );
    unmount();
    const restored = renderHook(() => useHostMetricsPreferences(7, defaults));
    expect(restored.result.current.layout).toEqual(latest);
    await act(async () => {});
    expect(restored.result.current.layout).toEqual(latest);
  });

  it("loads existing saved dimensions unchanged and persists return to auto height", async () => {
    api.getHostMetricsLayout.mockResolvedValue(layout);
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    await act(async () => {});
    expect(result.current.layout).toEqual(layout);
    const auto = { ...layout, slots: [{ ...layout.slots[0], height: null }] };
    act(() => result.current.setLayout(auto));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(7, auto);
  });
});

describe("layout history", () => {
  const actions: Array<
    [string, (current: HostMetricsLayout) => HostMetricsLayout]
  > = [
    [
      "resize",
      (current) => ({
        ...current,
        slots: current.slots.map((slot, i) =>
          i === 0 ? { ...slot, width: 573, height: 720 } : slot,
        ),
      }),
    ],
    [
      "reorder",
      (current) => ({
        ...current,
        slots: [...current.slots]
          .reverse()
          .map((slot, order) => ({ ...slot, order })),
      }),
    ],
    [
      "add",
      (current) => ({
        ...current,
        slots: [
          ...current.slots,
          { id: "disk", order: 2, colSpan: 1, height: null },
        ],
      }),
    ],
    ["remove", (current) => ({ ...current, slots: current.slots.slice(1) })],
    ["columns", (current) => ({ ...current, columns: 2 })],
    ["reset", () => ({ columns: 3, slots: [] })],
  ];

  it.each(actions)(
    "undoes and redoes %s as a complete layout snapshot",
    async (_name, change) => {
      api.getHostMetricsLayout.mockResolvedValue(defaults);
      const { result } = renderHook(() =>
        useHostMetricsPreferences(7, defaults),
      );
      await act(async () => {});
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(false);
      const next = change(defaults);
      act(() => result.current.setLayout(next));
      expect(result.current.layout).toEqual(next);
      expect(result.current.canUndo).toBe(true);
      act(() => result.current.undo());
      expect(result.current.layout).toEqual(defaults);
      expect(result.current.canUndo).toBe(false);
      expect(result.current.canRedo).toBe(true);
      act(() => result.current.redo());
      expect(result.current.layout).toEqual(next);
      expect(result.current.canRedo).toBe(false);
      await act(async () => {
        vi.advanceTimersByTime(800);
      });
      expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(
        7,
        next,
      );
    },
  );

  it("records consecutive user actions, ignores no-ops and invalidates redo only for a new change", async () => {
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    await act(async () => {});
    const columns = { ...defaults, columns: 2 };
    act(() => {
      result.current.setLayout(columns);
      result.current.setLayout(layout);
    });
    act(() => result.current.undo());
    expect(result.current.layout).toEqual(columns);
    act(() => result.current.setLayout(structuredClone(columns)));
    expect(result.current.canRedo).toBe(true);
    act(() => result.current.redo());
    expect(result.current.layout).toEqual(layout);
    act(() => result.current.undo());
    const next = { ...columns, columns: 1 };
    act(() => result.current.setLayout(next));
    expect(result.current.canRedo).toBe(false);
    act(() => result.current.redo());
    expect(result.current.layout).toEqual(next);
    act(() => result.current.undo());
    expect(result.current.layout).toEqual(columns);
    act(() => result.current.undo());
    expect(result.current.layout).toEqual(defaults);
  });

  it("hydrates remote preferences without an undo step or backend write", async () => {
    localStorage.setItem("hostMetricsLayout:7", JSON.stringify(defaults));
    const remote = deferred<HostMetricsLayout>();
    api.getHostMetricsLayout.mockReturnValue(remote.promise);
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    expect(result.current.layout).toEqual(defaults);
    expect(result.current.loaded).toBe(false);
    await act(async () => {
      remote.resolve(layout);
    });
    expect(result.current.layout).toEqual(layout);
    expect(result.current.loaded).toBe(true);
    expect(result.current.canUndo).toBe(false);
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:7")!)).toEqual(
      layout,
    );
    act(() => result.current.undo());
    expect(result.current.layout).toEqual(layout);
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveHostMetricsLayout).not.toHaveBeenCalled();
    act(() => result.current.setLayout(defaults));
    act(() => result.current.undo());
    expect(result.current.layout).toEqual(layout);
  });

  it("never overwrites an early edit or undo with late hydration", async () => {
    const remote = deferred<HostMetricsLayout>();
    api.getHostMetricsLayout.mockReturnValue(remote.promise);
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    act(() => result.current.setLayout({ ...defaults, columns: 1 }));
    act(() => result.current.undo());
    await act(async () => {
      remote.resolve(layout);
    });
    expect(result.current.layout).toEqual(defaults);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(true);
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:7")!)).toEqual(
      defaults,
    );
    act(() => result.current.redo());
    expect(result.current.layout.columns).toBe(1);
  });

  it("isolates hosts, flushes the previous host's debounce and ignores its stale hydration", async () => {
    const remote7 = deferred<HostMetricsLayout>();
    const remote8 = deferred<HostMetricsLayout>();
    api.getHostMetricsLayout.mockImplementation((id: number) =>
      id === 7 ? remote7.promise : remote8.promise,
    );
    const { result, rerender } = renderHook(
      ({ hostId }: { hostId: number | null }) =>
        useHostMetricsPreferences(hostId, defaults),
      { initialProps: { hostId: 7 as number | null } },
    );
    act(() => result.current.setLayout(layout));
    rerender({ hostId: 8 });
    expect(result.current.layout).toEqual(defaults);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.loaded).toBe(false);
    await act(async () => {
      remote7.resolve({ ...layout, columns: 4 });
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(
      7,
      layout,
    );
    expect(result.current.layout).toEqual(defaults);
    expect(localStorage.getItem("hostMetricsLayout:8")).toBeNull();
    const host8 = { ...defaults, columns: 2 };
    await act(async () => {
      remote8.resolve(host8);
    });
    expect(result.current.layout).toEqual(host8);
    expect(result.current.canUndo).toBe(false);
    act(() => result.current.setLayout({ ...host8, columns: 1 }));
    act(() => result.current.undo());
    expect(result.current.layout).toEqual(host8);
    rerender({ hostId: null });
    expect(result.current.layout).toEqual(defaults);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    act(() => result.current.setLayout(layout));
    expect(result.current.layout).toEqual(defaults);
    rerender({ hostId: 7 });
    expect(result.current.layout).toEqual(layout);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });

  it("serializes in-flight writes and flushes the final edit on unmount", async () => {
    const firstWrite = deferred<void>();
    api.saveHostMetricsLayout.mockReturnValueOnce(firstWrite.promise);
    const { result, unmount } = renderHook(() =>
      useHostMetricsPreferences(7, defaults),
    );
    await act(async () => {});
    act(() => result.current.setLayout(layout));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    const next = { ...layout, columns: 2 };
    act(() => result.current.setLayout(next));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(
      7,
      layout,
    );
    await act(async () => {
      firstWrite.resolve();
    });
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, next);
    const last = { ...next, columns: 1 };
    act(() => result.current.setLayout(last));
    unmount();
    await act(async () => {});
    expect(api.saveHostMetricsLayout).toHaveBeenCalledTimes(3);
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, last);
  });

  it("retains cached history through a failed fetch and a failed save", async () => {
    localStorage.setItem("hostMetricsLayout:7", JSON.stringify(layout));
    api.getHostMetricsLayout.mockRejectedValue(new Error("offline"));
    api.saveHostMetricsLayout.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    await act(async () => {});
    expect(result.current.loaded).toBe(true);
    expect(result.current.layout).toEqual(layout);
    act(() => result.current.setLayout(defaults));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    act(() => result.current.undo());
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(result.current.layout).toEqual(layout);
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, layout);
  });
});

describe("edit sessions", () => {
  const changed = {
    ...defaults,
    slots: [
      {
        ...defaults.slots[0],
        settings: { showCores: false, chartSize: "large" as const },
      },
    ],
  };

  it("discards card choices, dimensions and settings to the edit-entry snapshot, not defaults", async () => {
    api.getHostMetricsLayout.mockResolvedValue(layout);
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    await act(async () => {});
    act(() => result.current.beginEditing());
    expect(result.current.isEditing).toBe(true);
    act(() => result.current.setLayout(changed));
    act(() => result.current.undo());
    expect(result.current.layout).toEqual(layout);
    act(() => result.current.redo());
    expect(result.current.layout).toEqual(changed);
    act(() => result.current.discardChanges());
    expect(result.current.layout).toEqual(layout);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(result.current.isEditing).toBe(false);
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:7")!)).toEqual(
      layout,
    );
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(
      7,
      layout,
    );
  });

  it("restores after in-flight edits and flushes the restore on leaving immediately", async () => {
    api.getHostMetricsLayout.mockResolvedValue(layout);
    const write = deferred<void>();
    api.saveHostMetricsLayout.mockReturnValueOnce(write.promise);
    const { result, unmount } = renderHook(() =>
      useHostMetricsPreferences(7, defaults),
    );
    await act(async () => {});
    act(() => result.current.beginEditing());
    act(() => result.current.setLayout(changed));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    act(() => result.current.setLayout({ ...changed, slots: [] }));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    act(() => result.current.discardChanges());
    unmount();
    expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(
      7,
      changed,
    );
    await act(async () => {
      write.resolve();
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledTimes(3);
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, layout);
  });

  it("starts a new snapshot on each edit entry and isolates the session on host switches", async () => {
    const { result, rerender } = renderHook(
      ({ hostId }) => useHostMetricsPreferences(hostId, defaults),
      { initialProps: { hostId: 7 } },
    );
    await act(async () => {});
    act(() => result.current.beginEditing());
    act(() => result.current.setLayout(changed));
    act(() => result.current.finishEditing());
    act(() => result.current.beginEditing());
    act(() => result.current.setLayout(defaults));
    act(() => result.current.discardChanges());
    expect(result.current.layout).toEqual(changed);
    act(() => result.current.beginEditing());
    rerender({ hostId: 8 });
    expect(result.current.isEditing).toBe(false);
    expect(result.current.layout).toEqual(defaults);
    act(() => result.current.discardChanges());
    expect(result.current.layout).toEqual(defaults);
    await act(async () => {});
    expect(api.saveHostMetricsLayout).not.toHaveBeenCalledWith(8, changed);
  });

  it("protects the entry snapshot from late hydration and ignores corrupt cached settings", async () => {
    localStorage.setItem(
      "hostMetricsLayout:7",
      JSON.stringify({
        ...defaults,
        slots: [
          {
            ...defaults.slots[0],
            settings: { chartSize: "giant", showCores: "false" },
          },
        ],
      }),
    );
    const remote = deferred<HostMetricsLayout>();
    api.getHostMetricsLayout.mockReturnValue(remote.promise);
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    const entry = result.current.layout;
    expect(entry.slots[0]).not.toHaveProperty("settings");
    act(() => result.current.beginEditing());
    await act(async () => {
      remote.resolve(layout);
    });
    act(() => result.current.setLayout(changed));
    act(() => result.current.discardChanges());
    expect(result.current.layout).toEqual(entry);
  });
});

describe("dashboard template replacement", () => {
  const template = { id: 1, name: "Dashboard", layout };

  it("still hydrates an unselected host when its initial read completes after applying elsewhere", async () => {
    const remote = deferred<HostMetricsLayout>();
    api.getHostMetricsLayout.mockReturnValue(remote.promise);
    api.applyLayoutTemplate.mockResolvedValueOnce([
      { hostId: 8, applied: true },
    ]);
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    await act(async () => {
      await result.current.applyTemplate(template, [8]);
    });
    const original = { ...defaults, columns: 4 };
    await act(async () => {
      remote.resolve(original);
    });
    expect(result.current.layout).toEqual(original);
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:7")!)).toEqual(
      original,
    );
    expect(api.saveHostMetricsLayout).not.toHaveBeenCalled();
  });

  it("drains in-flight, queued and debounced edits before applying; no stale writes or hydration overwrite replacement", async () => {
    const remote = deferred<HostMetricsLayout>();
    const write = deferred<void>();
    api.getHostMetricsLayout.mockReturnValue(remote.promise);
    api.saveHostMetricsLayout.mockReturnValueOnce(write.promise);
    const { result, unmount } = renderHook(() =>
      useHostMetricsPreferences(7, defaults),
    );
    act(() => result.current.beginEditing());
    act(() => result.current.setLayout({ ...defaults, columns: 1 }));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    act(() => result.current.setLayout({ ...defaults, columns: 2 }));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    act(() => result.current.setLayout({ ...defaults, columns: 4 }));
    let application!: Promise<unknown>;
    act(() => {
      application = result.current.applyTemplate(template, [7]);
    });
    expect(api.applyLayoutTemplate).not.toHaveBeenCalled();
    // Edits and undo/discard while replacement is pending cannot replay an old layout.
    act(() => {
      result.current.setLayout(defaults);
      result.current.undo();
      result.current.discardChanges();
    });
    await act(async () => {
      write.resolve();
      await application;
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledTimes(3);
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, {
      ...defaults,
      columns: 4,
    });
    expect(api.applyLayoutTemplate).toHaveBeenCalledExactlyOnceWith(1, [7]);
    expect(result.current.layout).toEqual(layout);
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:7")!)).toEqual(
      layout,
    );
    await act(async () => {
      remote.resolve(defaults);
      vi.advanceTimersByTime(2000);
    });
    expect(result.current.layout).toEqual(layout);
    act(() => result.current.discardChanges());
    expect(result.current.layout).toEqual(layout);
    unmount();
    await act(async () => {});
    expect(api.saveHostMetricsLayout).toHaveBeenCalledTimes(4);
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, layout);
  });

  it("keeps the current layout on partial failure, updates only successful caches, and remains editable after retry", async () => {
    api.applyLayoutTemplate.mockResolvedValueOnce([
      { hostId: 7, applied: false, error: "access_denied" },
      { hostId: 8, applied: true },
    ]);
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    await act(async () => {});
    act(() => result.current.setLayout({ ...defaults, columns: 1 }));
    await act(async () => {
      await result.current.applyTemplate(template, [7, 8]);
    });
    expect(result.current.layout.columns).toBe(1);
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:8")!)).toEqual(
      layout,
    );
    expect(
      JSON.parse(localStorage.getItem("hostMetricsLayout:7")!).columns,
    ).toBe(1);
    await act(async () => {
      await result.current.applyTemplate(template, [7]);
    });
    expect(result.current.layout).toEqual(layout);
    act(() => result.current.setLayout(defaults));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, defaults);
  });

  it("retains pending edits on request failure and permits later edits", async () => {
    api.applyLayoutTemplate.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useHostMetricsPreferences(7, defaults));
    await act(async () => {});
    act(() => result.current.setLayout(layout));
    await act(async () => {
      await expect(result.current.applyTemplate(template, [7])).rejects.toThrow(
        "offline",
      );
    });
    expect(api.saveHostMetricsLayout).toHaveBeenCalledExactlyOnceWith(
      7,
      layout,
    );
    expect(result.current.layout).toEqual(layout);
    act(() => result.current.setLayout(defaults));
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
    expect(api.saveHostMetricsLayout).toHaveBeenLastCalledWith(7, defaults);
  });

  it("does not replace an unselected active host when navigating during a pending application", async () => {
    const applying = deferred<Array<{ hostId: number; applied: boolean }>>();
    api.applyLayoutTemplate.mockReturnValueOnce(applying.promise);
    const { result, rerender } = renderHook(
      ({ hostId }) => useHostMetricsPreferences(hostId, defaults),
      { initialProps: { hostId: 7 } },
    );
    await act(async () => {});
    let done!: Promise<unknown>;
    act(() => {
      done = result.current.applyTemplate(template, [7]);
    });
    await act(async () => {});
    rerender({ hostId: 8 });
    await act(async () => {
      applying.resolve([{ hostId: 7, applied: true }]);
      await done;
    });
    expect(result.current.layout).toEqual(defaults);
    expect(localStorage.getItem("hostMetricsLayout:8")).toBeNull();
    expect(JSON.parse(localStorage.getItem("hostMetricsLayout:7")!)).toEqual(
      layout,
    );
  });
});
