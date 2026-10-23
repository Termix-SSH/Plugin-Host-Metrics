import type { Request, Response, Router } from "express";
import {
  MAX_TEMPLATE_HOSTS,
  templateLayout,
  type LayoutTemplate,
  type LayoutTemplateHost,
  type LayoutTemplateApplyResult,
} from "../shared/layout-templates.js";
import { deriveEnabledWidgets } from "../shared/host-metrics.js";
import type { LayoutTemplateRow } from "./repository.js";
import type { RouteDeps } from "./routes.js";

class InputError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function templateId(req: Request): number {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new InputError(400, "invalid_id");
  return id;
}

function toTemplate(row: LayoutTemplateRow): LayoutTemplate {
  const layout = templateLayout(JSON.parse(row.layout));
  if (!layout) throw new Error("Invalid saved dashboard template");
  return { id: row.id, name: row.name, layout };
}

/** Personal apply-once layouts. Only owners sync enabledWidgets; never opens SSH. */
export function registerLayoutTemplateRoutes(
  router: Router,
  deps: RouteDeps,
): void {
  const { ctx, repository, log } = deps;
  const route =
    (
      operation: string,
      fn: (req: Request, userId: string) => Promise<unknown>,
    ) =>
    async (req: Request, res: Response) => {
      const userId = ctx.currentActor();
      if (!userId)
        return res.status(401).json({ error: "Authentication required" });
      try {
        res.json(await ctx.asUser(userId, () => fn(req, userId)));
      } catch (error) {
        if (error instanceof InputError)
          return res.status(error.status).json({ error: error.code });
        log.error("Dashboard template operation failed", error, { operation });
        res.status(500).json({ error: "save_failed" });
      }
    };
  async function owned(
    req: Request,
    userId: string,
  ): Promise<LayoutTemplateRow> {
    const row = await repository.findTemplate(userId, templateId(req));
    if (!row) throw new InputError(404, "template_not_found");
    return row;
  }

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/layout-templates:
   *   get:
   *     summary: List the acting user's dashboard layout templates
   *     tags: [Host Metrics]
   *     responses:
   *       200: { description: Personal named layouts. }
   *   post:
   *     summary: Save a personal named dashboard layout template
   *     tags: [Host Metrics]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name, layout]
   *             properties:
   *               name: { type: string, minLength: 1, maxLength: 100 }
   *               layout: { type: object, description: The Host Metrics preferences layout including slots and columns. }
   *     responses:
   *       200: { description: Saved template. }
   *       400: { description: Invalid name or layout. }
   */
  router.get(
    "/host-metrics/layout-templates",
    route("templates_list", async (_req, userId) => ({
      templates: (await repository.listTemplates(userId)).flatMap((row) => {
        try {
          return [toTemplate(row)];
        } catch {
          log.warn("Skipping invalid dashboard template", {
            templateId: row.id,
          });
          return [];
        }
      }),
    })),
  );
  router.post(
    "/host-metrics/layout-templates",
    route("templates_create", async (req, userId) => {
      const { name, layout: input } = req.body ?? {};
      const layout = templateLayout(input);
      if (
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 100 ||
        !layout
      )
        throw new InputError(400, "invalid_template");
      const row = await repository.createTemplate(userId, {
        name: name.trim(),
        layout: JSON.stringify(layout),
      });
      if (!row) throw new InputError(400, "too_many_templates");
      return toTemplate(row);
    }),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/layout-templates/{id}:
   *   delete:
   *     summary: Delete a personal template without changing host layouts
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     responses:
   *       200: { description: Template deleted. }
   *       404: { description: Template not found for this user. }
   */
  router.delete(
    "/host-metrics/layout-templates/:id",
    route("templates_delete", async (req, userId) => {
      const row = await owned(req, userId);
      await repository.deleteTemplate(userId, row.id);
      return { success: true };
    }),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/layout-templates/hosts:
   *   get:
   *     summary: List accessible hosts by name and folder, without credentials
   *     tags: [Host Metrics]
   *     responses:
   *       200: { description: Hosts with connect access, matching layout preferences. }
   */
  router.get(
    "/host-metrics/layout-templates/hosts",
    route("templates_hosts", async () => {
      const hosts: LayoutTemplateHost[] = [];
      for (const host of await ctx.hosts.list()) {
        if ((await ctx.hosts.checkAccess(host.id, "connect")).hasAccess)
          hosts.push({
            id: host.id,
            name: host.name ?? host.ip,
            folder: host.folder,
          });
      }
      return { hosts };
    }),
  );

  /**
   * @openapi
   * /plugin-api/host-metrics/host-metrics/layout-templates/{id}/apply:
   *   post:
   *     summary: Replace the acting user's layouts on selected accessible hosts
   *     description: Applies once. No other users, health checks or host sampling settings change.
   *     tags: [Host Metrics]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [hostIds]
   *             properties:
   *               hostIds: { type: array, minItems: 1, maxItems: 100, items: { type: integer, minimum: 1 } }
   *     responses:
   *       200: { description: Per-host success or failure; failed hosts can be retried. }
   *       400: { description: Invalid host selection. }
   *       404: { description: Template not found for this user. }
   */
  router.post(
    "/host-metrics/layout-templates/:id/apply",
    route("templates_apply", async (req, userId) => {
      const template = toTemplate(await owned(req, userId));
      const { hostIds } = req.body ?? {};
      if (
        !Array.isArray(hostIds) ||
        !hostIds.length ||
        hostIds.length > MAX_TEMPLATE_HOSTS ||
        !hostIds.every((id) => Number.isSafeInteger(id) && id > 0)
      )
        throw new InputError(400, "invalid_hosts");
      const results: LayoutTemplateApplyResult[] = [];
      for (const hostId of new Set<number>(hostIds)) {
        try {
          const access = await ctx.hosts.checkAccess(hostId, "connect");
          if (!access.hasAccess) throw new InputError(403, "access_denied");
          await repository.saveLayout(
            userId,
            hostId,
            JSON.stringify(template.layout),
          );
          // Same as saving preferences: owners keep enabledWidgets in step.
          if (access.isOwner)
            await ctx.settings.setHost(
              hostId,
              "enabledWidgets",
              deriveEnabledWidgets(template.layout.slots),
            );
          results.push({ hostId, applied: true });
        } catch (error) {
          if (!(error instanceof InputError))
            log.error("Failed to apply dashboard template", error, {
              operation: "templates_apply",
              hostId,
            });
          results.push({
            hostId,
            applied: false,
            error: error instanceof InputError ? error.code : "save_failed",
          });
        }
      }
      return { results };
    }),
  );
}
