import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import en from "../../locales/en.json";
import { DataTransfer } from "../../src/frontend/DataTransfer";

const mocks = vi.hoisted(() => ({
  exportData: vi.fn(),
  importData: vi.fn(),
}));
vi.mock("../../src/frontend/host-metrics-api", () => ({
  useHostMetricsApi: () => mocks,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      let value =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        key.split(".").reduce((obj: any, part) => obj?.[part], en) ?? key;
      for (const [name, replacement] of Object.entries(values))
        value = value.replaceAll(`{{${name}}}`, String(replacement));
      return value;
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const view = () =>
  render(
    <SurfaceScope>
      <DataTransfer onClose={() => {}} />
    </SurfaceScope>,
  );

describe("DataTransfer", () => {
  it("exports with the history choice", async () => {
    mocks.exportData.mockResolvedValue({ plugin: "host-metrics" });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    view();
    fireEvent.click(screen.getByRole("checkbox", { name: /include history/i }));
    fireEvent.click(screen.getByText("Download file"));
    await waitFor(() => expect(mocks.exportData).toHaveBeenCalledWith(true));
  });

  it("imports a file and shows the result", async () => {
    mocks.importData.mockResolvedValue({
      imported: 2,
      updated: 0,
      skipped: 1,
      failed: 0,
      errors: [],
    });
    view();
    const file = new File(
      [JSON.stringify({ plugin: "host-metrics" })],
      "a.json",
    );
    file.text = async () => JSON.stringify({ plugin: "host-metrics" });
    fireEvent.change(screen.getByTestId("metrics-import-file"), {
      target: { files: [file] },
    });
    expect(
      await screen.findByText(/Imported 2, updated 0, skipped 1/),
    ).toBeVisible();
  });

  it("rejects a file that is not an export", async () => {
    view();
    const file = new File(["{}"], "a.json");
    file.text = async () => "{}";
    fireEvent.change(screen.getByTestId("metrics-import-file"), {
      target: { files: [file] },
    });
    expect(
      await screen.findByText(en.hostMetrics.transfer.invalidFile),
    ).toBeVisible();
    expect(mocks.importData).not.toHaveBeenCalled();
  });
});
