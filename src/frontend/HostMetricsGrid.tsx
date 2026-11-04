import { useMemo, useState, type ReactNode } from "react";
import {
  TileGrid,
  TilePicker,
  appendTile,
  type GridCardCatalogEntry,
  type TileSlot,
} from "@termix-ssh/plugin-sdk/ui";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { CardSettingsView } from "./card-settings";
import {
  clampColumns,
  columnsFromSpan,
  placeSlots,
  slotsFromBoxes,
  type PlacedSlot,
} from "./grid-layout";
import {
  GRID_COLUMNS,
  type HostMetricsCardId,
  type HostMetricsLayout,
} from "../shared/host-metrics.js";

type Slot = HostMetricsLayout["slots"][number];

// Cards keep their own log and chart rules when the grid pins their height.
const styles = `
.tg-card[data-fixed-height="true"] > .tg-content > div > div:last-child {
  max-height: none !important;
  overflow: auto;
}
.tg-card[data-fixed-height="true"] [data-host-metrics-log] {
  max-height: none;
  min-height: 0;
  flex: 1 1 0%;
}
.tg-card[data-fixed-height="true"] > .tg-content > div > div:last-child:has(> [data-host-metrics-log]) {
  display: flex;
  flex-direction: column;
}
.tg-card[data-fixed-height="true"] > .tg-content > div > div:last-child:has(> [data-host-metrics-log]) > :not([data-host-metrics-log]) {
  flex-shrink: 0;
}
`;

const toTiles = (slots: PlacedSlot[]): TileSlot[] =>
  slots.map((slot) => ({
    id: slot.id,
    x: slot.x,
    y: slot.y,
    w: slot.w,
    h: slot.height ?? null,
  }));

/**
 * Host Metrics cards on the shared tile grid. The saved layout keeps its own
 * fields (order, colSpan, card settings) for older clients, so this only
 * maps positions in and out.
 */
export function HostMetricsGrid({
  layout,
  editMode,
  renderCard,
  cardCatalog,
  cardLabel,
  onChange,
}: {
  layout: HostMetricsLayout;
  editMode: boolean;
  renderCard: (id: string) => ReactNode;
  cardCatalog: GridCardCatalogEntry[];
  cardLabel: (id: string) => string;
  onChange: (layout: HostMetricsLayout) => void;
}) {
  const { t } = useTranslation();
  const [settingsFor, setSettingsFor] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);
  const placed = useMemo(() => placeSlots(layout), [layout]);
  const tiles = useMemo(() => toTiles(placed), [placed]);

  const save = (next: TileSlot[], extra?: Slot) => {
    const byId = new Map(placed.map((slot) => [slot.id, slot]));
    const kept: PlacedSlot[] = [];
    for (const tile of next) {
      const slot = byId.get(tile.id as HostMetricsCardId) ?? extra;
      if (!slot) continue;
      kept.push({
        ...slot,
        id: tile.id as HostMetricsCardId,
        x: tile.x,
        y: tile.y,
        w: tile.w,
        height: tile.h ?? null,
      } as PlacedSlot);
    }
    onChange({
      columns: layout.columns,
      slots: slotsFromBoxes(
        kept,
        kept.map((slot) => ({
          id: slot.id,
          x: slot.x,
          y: slot.y,
          w: slot.w,
          h: 0,
        })),
      ),
    });
  };

  const add = (entry: GridCardCatalogEntry) => {
    const colSpan = entry.defaultColSpan ?? 1;
    const fresh: Slot = {
      id: entry.id as HostMetricsCardId,
      order: placed.length,
      colSpan,
      height: entry.defaultHeight ?? null,
    };
    save(
      appendTile(tiles, {
        id: entry.id,
        w: columnsFromSpan(colSpan, layout.columns),
        h: entry.defaultHeight ?? null,
      }),
      fresh,
    );
  };

  const saveSettings = (id: string, patch: Partial<Slot>) => {
    const next = placed.map((slot) => {
      if (slot.id !== id) return slot;
      const w = clampColumns(patch.w ?? slot.w);
      return {
        ...slot,
        ...patch,
        w,
        x: Math.min(slot.x, GRID_COLUMNS - w),
        y: slot.y,
      };
    });
    onChange({
      columns: layout.columns,
      slots: slotsFromBoxes(
        next,
        next.map((slot) => ({
          id: slot.id,
          x: slot.x,
          y: slot.y,
          w: slot.w,
          h: 0,
        })),
      ),
    });
  };

  const present = new Set<string>(placed.map((slot) => slot.id));
  const group = t("hostMetrics.grid.cards");
  const entries = cardCatalog.map((entry) => ({
    id: entry.id,
    title: entry.label,
    description: entry.description,
    group,
    kind: "chart" as const,
    placed: present.has(entry.id),
  }));
  const settingsSlot = placed.find((slot) => slot.id === settingsFor);

  return (
    <div className="flex min-h-0 gap-0">
      <style>{styles}</style>
      <div className="min-w-0 flex-1">
        <TileGrid
          slots={tiles}
          editMode={editMode}
          renderTile={renderCard}
          tileLabel={cardLabel}
          onChange={(next) => save(next)}
          onSettings={setSettingsFor}
          minHeight={80}
          empty={t("hostMetrics.grid.empty")}
        />
        {editMode && !pickerOpen && (
          <button
            type="button"
            onClick={() => setPickerOpen(true)}
            className="mt-3 border border-dashed border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {t("hostMetrics.grid.addCard")}
          </button>
        )}
      </div>
      {editMode && pickerOpen && (
        <TilePicker
          className="sticky top-0 max-h-[80vh]"
          entries={entries}
          onAdd={(entry) => {
            const found = cardCatalog.find((card) => card.id === entry.id);
            if (found) add(found);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {editMode && settingsSlot && (
        <CardSettingsView
          id={settingsSlot.id}
          label={cardLabel(settingsSlot.id)}
          slot={settingsSlot}
          renderedHeight={settingsSlot.height ?? 160}
          onSave={(patch) => saveSettings(settingsSlot.id, patch)}
          onClose={() => setSettingsFor(null)}
        />
      )}
    </div>
  );
}
