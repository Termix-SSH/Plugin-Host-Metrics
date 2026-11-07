import type { PluginContext, SyncRow } from "@termix-ssh/plugin-sdk/backend";

/**
 * Layouts and templates follow the user to linked desktops. A layout is one
 * row per host, so a row made on both sides is merged on its host.
 */
export function registerLayoutSync(
  ctx: PluginContext,
  tables: { preferences: unknown; templates: unknown },
) {
  ctx.sync.registerEntity({
    type: "hostMetricsLayouts",
    table: tables.preferences,
    // After hosts (50), so the host id resolves.
    order: 70,
    references: [
      { field: "hostId", syncField: "hostSyncId", entityType: "hosts" },
    ],
    matchOn: ["hostId"],
    deserialize: async (row: SyncRow) => {
      if (typeof row.hostId !== "number") {
        throw new Error("Host of a synced metrics layout is not here");
      }
      return row;
    },
  });
  ctx.sync.registerEntity({
    type: "hostMetricsTemplates",
    table: tables.templates,
    order: 70,
  });
}
