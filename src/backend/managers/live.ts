import { execCommand } from "@termix-ssh/plugin-sdk/host-commands";
import {
  liveCmd,
  parseLive,
  type LivePrev,
  type LiveSample,
} from "@termix-ssh/plugin-sdk/host-scripts";
import type { RequestHandler, Router } from "express";
import { createSamplers } from "./live-stream.js";
import { managerHandler } from "./route-helpers.js";
import type { ManagerRoutesDeps } from "./types.js";

export { liveCmd, parseLive, type LivePrev };

const STALE_MS = 60_000;

export function registerLiveRoutes(app: Router, deps: ManagerRoutesDeps): void {
  const { validateHostId, liveConfig } = deps;
  const streamed = createSamplers(deps.runOnHost);
  deps.onDispose?.(() => streamed.dispose?.());
  // One baseline and one in-flight/recent sample per host, shared by every user
  // and tab, so the host sees at most one exec per admin minimum interval.
  // shortcut: samples are host-level data and the access check runs first;
  // add a per-user key if per-user visibility is ever introduced.
  const prevs = new Map<number, LivePrev>();
  const recent = new Map<
    number,
    { at: number; minMs: number; pending: boolean; sample: Promise<LiveSample> }
  >();

  /** Stops disabled hosts before an SSH connection is borrowed. */
  const gate: RequestHandler = async (req, res, next) => {
    try {
      const config = await liveConfig(parseInt(String(req.params.id), 10));
      if (!config.enabled) {
        res
          .status(403)
          .json({ error: "Live updates are disabled", code: "LIVE_DISABLED" });
        return;
      }
      res.locals.liveMinMs = config.minSeconds * 1000;
      next();
    } catch (error) {
      next(error);
    }
  };

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/managers/live/{id}:
   *   get:
   *     summary: Lightweight live CPU, memory, network and process sample (Linux)
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200: { description: One live sample, shared per host and reused until the admin minimum interval passes. Includes minIntervalS. }
   *       403: { description: No access, or live updates are disabled (code LIVE_DISABLED). }
   */
  app.get(
    "/host-metrics/managers/live/:id",
    validateHostId,
    gate,
    managerHandler(
      deps,
      "connect",
      "live_sample",
      async (client, host, req) => {
        const minMs: number = req.res?.locals.liveMinMs;
        // Streaming: a held shell per host samples at the viewer pace, so a poll
        // only reads the cache. Requests without ?stream keep the one-exec path.
        if (req.query?.stream !== undefined) {
          // The admin minimum wins over the 5s cap, so a slower floor is never undercut.
          const ms = Math.min(
            Math.max(5000, minMs),
            Math.max(minMs, Number(req.query.ms) || minMs),
          );
          return {
            ...(await streamed(host.id, ms)),
            minIntervalS: minMs / 1000,
          };
        }
        const now = Date.now();
        // Entries live past their own minimum, so a long minimum is never cut short.
        for (const [k, v] of recent)
          if (!v.pending && now - v.at > Math.max(STALE_MS, v.minMs * 2)) {
            recent.delete(k);
            prevs.delete(k);
          }
        const hit = recent.get(host.id);
        // A running sample is always joined. Failures are reused too, which
        // backs a failing host off to the same pace.
        // The current policy is applied on the way out so a raised minimum reaches clients at once.
        const withPolicy = (p: Promise<LiveSample>) =>
          p.then((s) => ({ ...s, minIntervalS: minMs / 1000 }));
        if (hit && (hit.pending || now - hit.at < minMs)) {
          return withPolicy(hit.sample);
        }

        const before = prevs.get(host.id);
        const sample = (async () => {
          const { stdout, code } = await execCommand(
            client,
            liveCmd(before?.pageBytes),
            5000,
          );
          // A failed run must not replace the baseline with garbage.
          if (code !== 0) throw new Error("live sample failed");
          const parsed = parseLive(stdout, before, now);
          prevs.set(host.id, parsed.next);
          return parsed.sample;
        })();
        const entry = { at: now, minMs, pending: true, sample };
        recent.set(host.id, entry);
        const settle = () => {
          entry.pending = false;
        };
        sample.then(settle, settle);
        return withPolicy(sample);
      },
    ),
  );
}
