import {
  execCommand,
  execElevated,
} from "@termix-ssh/plugin-sdk/host-commands";
import type {
  PluginContext,
  PluginOperationContext,
} from "@termix-ssh/plugin-sdk/backend";
import { dashboardHealth, parseChecks } from "./managers/health.js";
import {
  buildKillCommand,
  LIST_PROCESSES_CMD,
  parseProcessList,
} from "./managers/processes.js";
import type { RunOnHost } from "./managers/types.js";
import { isValidPid, isValidSignal } from "./managers/validation.js";
import type { HostMetricsRepository } from "./repository.js";

const PS_TIMEOUT_MS = 20_000;

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
  ctx.operations.register("host-metrics.list-processes", {
    run: async (_input, context) => {
      const rows = await runOnHost(
        requireHost(context),
        "connect",
        async (client) => {
          const { stdout } = await execCommand(
            client,
            LIST_PROCESSES_CMD,
            PS_TIMEOUT_MS,
          );
          return parseProcessList(stdout);
        },
      );
      return { summary: `${rows.length} processes`, data: { rows } };
    },
  });

  ctx.operations.register("host-metrics.signal-process", {
    describe: (input, context) =>
      `Would send ${String(input.signal)} to process ${context.resourceKey}`,
    run: async (input, context) => {
      const pid = Number(context.resourceKey);
      const { signal } = input;
      if (!isValidPid(pid)) throw new Error("Invalid pid");
      if (!isValidSignal(signal)) throw new Error("Invalid signal");
      const result = await runOnHost(
        requireHost(context),
        "edit",
        // Unprivileged first, elevate only if the process isn't owned.
        (client, host) =>
          execElevated(
            client,
            buildKillCommand(pid, signal),
            host.sudoPassword,
          ),
      );
      return {
        summary: `Sent ${signal} to process ${pid}`,
        changed: result.code === 0,
        data: {
          success: result.code === 0,
          output: result.stdout || result.stderr,
          usedSudo: result.usedSudo,
        },
      };
    },
  });

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
      return {
        summary: health.level,
        data: {
          value: health.level,
          status: health.level === "crit" ? "fail" : health.level,
          label: health.level,
        },
      };
    },
  });
}
