import { afterEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import {
  renderWithApp,
  type RenderedPluginApp,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import * as plugin from "../../src/frontend/index";
import manifestJson from "../../manifest.json";
import locales from "../../locales/en.json";

const manifest = manifestJson as unknown as PluginManifest;

const declared = (views?: Array<{ id: string }>) =>
  (views ?? []).map((view) => view.id).sort();

let rendered: RenderedPluginApp | null = null;

afterEach(async () => {
  await rendered?.deactivate();
  rendered = null;
});

describe(`${manifest.id} activate`, () => {
  it("activates and registers only views its manifest declares", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    const contributes = manifest.contributes as unknown as Record<
      string,
      Array<{ id: string }> | undefined
    >;
    const tabs = declared(contributes.tabs);
    // A rail panel may reuse one of the plugin's tab ids.
    const panels = [...declared(contributes.panels), ...tabs];
    const cards = declared(contributes.dashboardCards);
    for (const id of rendered.registered.tabs()) expect(tabs).toContain(id);
    for (const id of rendered.registered.panels()) expect(panels).toContain(id);
    for (const id of rendered.registered.dashboardCards()) {
      expect(cards).toContain(id);
    }
  });

  it("fills core's metric slots and offers disk usage to other plugins", async () => {
    rendered = await renderWithApp(plugin, { manifest, locales });
    expect(rendered.registered.slot("dashboard.hostRow")).toEqual([
      "host-metrics.dashboardHost",
    ]);
    expect(rendered.registered.slot("homepage.hostMetrics")).toEqual([
      "host-metrics.homepageHost",
    ]);
    expect(rendered.registered.actions()).toContain("host-metrics.disk");
    expect(rendered.registered.hostEditorSections()).toEqual(["host-metrics"]);
  });

  it("removes everything it registered on deactivate", async () => {
    const app = await renderWithApp(plugin, { manifest, locales });
    await app.deactivate();
    expect(app.registered.tabs()).toEqual([]);
    expect(app.registered.panels()).toEqual([]);
    expect(app.registered.railItems()).toEqual([]);
    expect(app.registered.hostActions()).toEqual([]);
    expect(app.registered.hostEditorSections()).toEqual([]);
    expect(app.registered.dashboardCards()).toEqual([]);
    expect(app.registered.settingsComponents()).toEqual([]);
    expect(app.registered.actions()).toEqual([]);
  });
});

describe("busiest hosts card", () => {
  it("orders hosts by their highest load", async () => {
    rendered = await renderWithApp(plugin, {
      manifest,
      locales,
      permissions: ["host-metrics.use"],
      hosts: [
        { id: "1", name: "quiet", ip: "10.0.0.1", port: 22 },
        { id: "2", name: "busy", ip: "10.0.0.2", port: 22 },
      ],
      api: {
        get: vi.fn(async () => ({
          data: [
            { hostId: 1, cpu: 5, memory: 20, disk: 30, lastChecked: "" },
            { hostId: 2, cpu: 95, memory: 40, disk: 50, lastChecked: "" },
          ],
        })),
      } as never,
    });
    expect(rendered.registered.dashboardCards()).toEqual(["busiest-hosts"]);
    const card = rendered.renderDashboardCard("busiest-hosts");
    await screen.findByText("busy");
    const text = card.textContent ?? "";
    expect(text.indexOf("busy")).toBeLessThan(text.indexOf("quiet"));
  });
});
