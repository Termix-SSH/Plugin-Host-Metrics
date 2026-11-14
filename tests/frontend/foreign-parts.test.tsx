import { describe, expect, it } from "vitest";
import { renderWithApp } from "@termix-ssh/plugin-sdk/testing";
import * as plugin from "../../src/frontend/index";
import manifest from "../../manifest.json";

function OtherPart(props: Record<string, unknown>) {
  return <p>other part {String(props.hostId ?? "")}</p>;
}

describe("other plugins' parts", () => {
  it("draws what another plugin puts in host-metrics.managers", async () => {
    const rendered = await renderWithApp(plugin, {
      manifest: manifest as never,
      others: {
        slots: {
          "host-metrics.managers": [
            { actionId: "other.part", component: OtherPart },
          ],
        },
      },
    });
    const element = rendered.renderSlot("host-metrics.managers", { hostId: 7 });
    expect(element.textContent).toContain("other part 7");
    await rendered.deactivate();
  });

  it("draws what another plugin puts in host-metrics.toolbar", async () => {
    const rendered = await renderWithApp(plugin, {
      manifest: manifest as never,
      others: {
        slots: {
          "host-metrics.toolbar": [
            { actionId: "other.part", component: OtherPart },
          ],
        },
      },
    });
    const element = rendered.renderSlot("host-metrics.toolbar", { hostId: 7 });
    expect(element.textContent).toContain("other part 7");
    await rendered.deactivate();
  });
});
