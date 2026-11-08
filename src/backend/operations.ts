import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { dashboardHealth, parseChecks } from "./managers/health.js";
import type { RunOnHost } from "./managers/types.js";
import type { HostMetricsRepository } from "./repository.js";

function requireHost(context: PluginOperationContext): number {
  if (context.hostId === undefined) throw new Error("This needs a host");
  return context.hostId;
}

/** Everything Host Metrics offers to the rest of Termix. */
export function registerOperations(
  ctx: PluginContext,
  runOnHost: RunOnHost,
  repository: HostMetricsRepository,
): void {
  // Reads stored results only and never runs a check, so it stays cheap.
  ctx.operations.register("host-metrics.health", {
    run: async (_input, context) => {
      const hostId = requireHost(context);
      const userId = ctx.currentActor();
      if (!userId) throw new Error("This needs a user");
      const row = (await repository.listUserChecks(userId)).find(
        (entry) => entry.hostId === hostId,
      );
      const checks = row
        ? parseChecks(row.checks).filter((check) => check.dashboard)
        : [];
      const health = checks.length
        ? dashboardHealth(
            hostId,
            checks,
            await repository.listHealth(userId, hostId, 200),
          )
        : null;
      if (!health) {
        return {
          summary: "No checks",
          data: { status: "unknown", label: "No checks" },
        };
      }
      // Name the checks that are not passing, so the tile says what is wrong.
      const bad = health.checks.filter((check) => check.level !== "ok");
      const label = bad.length
        ? bad.map((check) => check.name).join(", ")
        : "All passing";
      return {
        summary: label,
        data: {
          value: health.level,
          status: health.level === "crit" ? "fail" : health.level,
          label,
        },
      };
    },
  });
}
