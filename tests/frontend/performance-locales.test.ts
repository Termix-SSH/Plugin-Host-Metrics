import { describe, expect, it } from "vitest";
import { createInstance } from "i18next";
import en from "../../locales/en.json";
import de from "../../locales/translated/de_DE.json";

describe("performance locale fallback", () => {
  it("keeps translated labels and falls back to English for new detail fields", async () => {
    const i18n = createInstance();
    await i18n.init({
      lng: "de",
      fallbackLng: "en",
      defaultNS: "host-metrics",
      resources: { en: { "host-metrics": en }, de: { "host-metrics": de } },
    });
    expect(i18n.t("hostMetrics.memory")).toBe(de.hostMetrics.memory);
    expect(i18n.t("hostMetrics.performance.unavailable")).toBe("Unavailable");
    expect(i18n.t("hostMetrics.performance.logicalProcessor", { id: 7 })).toBe(
      "Logical processor 7",
    );
  });
});
