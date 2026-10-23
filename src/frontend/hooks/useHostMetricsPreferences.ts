import {
  sanitizeLayout,
  type HostMetricsLayout,
} from "../../shared/host-metrics.js";
import { useEffect, useRef, useState } from "react";
import { useHostMetricsApi } from "../host-metrics-api";
import type { LayoutTemplate } from "../../shared/layout-templates.js";

const SAVE_DEBOUNCE_MS = 800;

function lsKey(hostId: number) {
  return `hostMetricsLayout:${hostId}`;
}

function readCache(hostId: number): HostMetricsLayout | null {
  try {
    const raw = localStorage.getItem(lsKey(hostId));
    if (!raw) return null;
    return sanitizeLayout(JSON.parse(raw));
  } catch {
    /* ignore */
  }
  return null;
}

function writeCache(hostId: number, layout: HostMetricsLayout) {
  try {
    localStorage.setItem(lsKey(hostId), JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

/**
 * Per-host Host Metrics layout, cached in localStorage for instant paint and
 * synced to the backend (so it follows the user across devices). Saves are
 * debounced. History contains user changes only, and resets on host switches.
 */
export function useHostMetricsPreferences(
  hostId: number | null,
  defaultLayout: HostMetricsLayout,
) {
  const { getHostMetricsLayout, saveHostMetricsLayout, applyLayoutTemplate } =
    useHostMetricsApi();
  const initialState = () => ({
    hostId,
    layout: hostId != null ? readCache(hostId) : null,
    loaded: false,
    edited: false,
    baseline: null as HostMetricsLayout | null,
    past: [] as HostMetricsLayout[],
    future: [] as HostMetricsLayout[],
  });
  const [state, setState] = useState(initialState);
  // Reset before rendering another host, including one without a cached layout.
  if (state.hostId !== hostId) setState(initialState());
  const pending = useRef<(() => void) | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saves = useRef(Promise.resolve());
  const replacing = useRef(false);
  const hydrationVersions = useRef(new Map<number, number>());

  useEffect(() => {
    if (hostId == null) return;
    let cancelled = false;
    const version = hydrationVersions.current.get(hostId);

    getHostMetricsLayout(hostId)
      .then((remote) => {
        if (
          cancelled ||
          !remote ||
          version !== hydrationVersions.current.get(hostId)
        )
          return;
        const layout = sanitizeLayout(remote);
        if (!layout) return;
        // A slow initial read must not overwrite edits, undo, or redo.
        setState((previous) =>
          previous.hostId === hostId && !previous.edited && !previous.baseline
            ? { ...previous, layout }
            : previous,
        );
      })
      .catch(() => {
        /* keep cache/default */
      })
      .finally(() => {
        if (!cancelled)
          setState((previous) =>
            previous.hostId === hostId
              ? { ...previous, loaded: true }
              : previous,
          );
      });

    return () => {
      cancelled = true;
    };
  }, [hostId, getHostMetricsLayout]);

  useEffect(() => {
    if (replacing.current) return;
    if (hostId == null || state.hostId !== hostId || !state.layout) return;
    writeCache(hostId, state.layout);
    if (!state.edited) return;
    const next = state.layout;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    pending.current = () => {
      pending.current = null;
      // Preserve write order even if a previous request takes longer than the debounce.
      saves.current = saves.current
        .then(() => saveHostMetricsLayout(hostId, next))
        .catch(() => {
          /* best-effort; cache already holds it */
        });
    };
    saveTimer.current = setTimeout(() => pending.current?.(), SAVE_DEBOUNCE_MS);
  }, [hostId, state.hostId, state.layout, state.edited, saveHostMetricsLayout]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      // Keep the last edit when switching hosts or leaving before the debounce fires.
      pending.current?.();
    };
  }, [hostId]);

  const save = (next: HostMetricsLayout) => {
    if (hostId == null || replacing.current) return;
    setState((previous) => {
      if (previous.hostId !== hostId) return previous;
      const current = previous.layout ?? defaultLayout;
      if (JSON.stringify(current) === JSON.stringify(next)) return previous;
      return {
        ...previous,
        layout: next,
        edited: true,
        past: [...previous.past, current],
        future: [],
      };
    });
  };
  const travel = (direction: "past" | "future") => {
    if (hostId == null || replacing.current) return;
    setState((previous) => {
      if (previous.hostId !== hostId || !previous[direction].length)
        return previous;
      const other = direction === "past" ? "future" : "past";
      return {
        ...previous,
        layout: previous[direction].at(-1)!,
        edited: true,
        [direction]: previous[direction].slice(0, -1),
        [other]: [...previous[other], previous.layout ?? defaultLayout],
      };
    });
  };

  return {
    applyTemplate: async (template: LayoutTemplate, hostIds: number[]) => {
      if (replacing.current)
        throw new Error("A dashboard template is already being applied");
      // Drain earlier writes before replacement; neither debounce nor unmount may replay them after it.
      replacing.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      pending.current?.();
      try {
        await saves.current;
        const results = await applyLayoutTemplate(template.id, hostIds);
        const applied = new Set(
          results
            .filter((result) => result.applied && !result.error)
            .map((result) => result.hostId),
        );
        for (const id of applied) {
          writeCache(id, template.layout);
          hydrationVersions.current.set(
            id,
            (hydrationVersions.current.get(id) ?? 0) + 1,
          );
        }
        setState((previous) =>
          previous.hostId != null && applied.has(previous.hostId)
            ? {
                ...previous,
                layout: template.layout,
                loaded: true,
                edited: false,
                baseline: previous.baseline ? template.layout : null,
                past: [],
                future: [],
              }
            : previous,
        );
        return results;
      } finally {
        replacing.current = false;
      }
    },
    layout: state.layout ?? defaultLayout,
    setLayout: save,
    loaded: state.loaded,
    isEditing: state.baseline !== null,
    beginEditing: () =>
      setState((previous) =>
        previous.hostId === hostId &&
        hostId != null &&
        !previous.baseline &&
        !replacing.current
          ? {
              ...previous,
              baseline: previous.layout ?? defaultLayout,
              past: [],
              future: [],
            }
          : previous,
      ),
    finishEditing: () =>
      setState((previous) =>
        replacing.current ? previous : { ...previous, baseline: null },
      ),
    discardChanges: () =>
      setState((previous) =>
        previous.hostId === hostId && previous.baseline && !replacing.current
          ? {
              ...previous,
              layout: previous.baseline,
              baseline: null,
              edited: true,
              past: [],
              future: [],
            }
          : previous,
      ),
    undo: () => travel("past"),
    redo: () => travel("future"),
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  };
}
