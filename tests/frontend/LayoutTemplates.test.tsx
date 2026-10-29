import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { SurfaceScope } from "@termix-ssh/plugin-sdk/ui";
import en from "../../locales/en.json";
import { LayoutTemplates } from "../../src/frontend/LayoutTemplates";
import { HealthCheckCard } from "../../src/frontend/cards/managers/HealthCheckCard";
import type { LayoutTemplate } from "../../src/shared/layout-templates";

const mocks = vi.hoisted(() => ({
  getLayoutTemplates: vi.fn(),
  getLayoutTemplateHosts: vi.fn(),
  createLayoutTemplate: vi.fn(),
  deleteLayoutTemplate: vi.fn(),
  apply: vi.fn(),
  confirm: vi.fn(),
  managerGet: vi.fn(),
  managerPost: vi.fn(),
}));
vi.mock("../../src/frontend/host-metrics-api", () => ({
  useHostMetricsApi: () => mocks,
}));
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({
    t: (key: string, values: Record<string, unknown> = {}) => {
      let value =
        key.split(".").reduce((obj: any, part) => obj?.[part], en) ?? key;
      for (const [name, replacement] of Object.entries(values))
        value = value.replaceAll(`{{${name}}}`, String(replacement));
      return value;
    },
  }),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", async (original) => ({
  ...(await original<object>()),
  useConfirm: () => mocks.confirm,
}));
const template: LayoutTemplate = {
  id: 1,
  name: "Dashboard",
  layout: {
    columns: 2,
    slots: [
      {
        id: "memory",
        order: 1,
        colSpan: 2,
        height: 480,
        x: 0,
        y: 300,
        w: 6,
        settings: { chartSize: "large", showDetails: false },
      },
      {
        id: "cpu",
        order: 0,
        colSpan: 1,
        height: null,
        settings: { showCores: false },
      },
    ],
  },
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getLayoutTemplates.mockResolvedValue([template]);
  mocks.getLayoutTemplateHosts.mockResolvedValue([
    { id: 7, name: "Alpha", folder: "Production" },
    { id: 8, name: "Beta", folder: "Staging" },
  ]);
  mocks.createLayoutTemplate.mockResolvedValue({
    ...template,
    id: 2,
    name: "New dashboard",
  });
  mocks.deleteLayoutTemplate.mockResolvedValue(undefined);
  mocks.confirm.mockResolvedValue(true);
  mocks.apply.mockResolvedValue([{ hostId: 7, applied: true }]);
  mocks.managerGet.mockResolvedValue({ checks: [], results: [], history: [] });
});
afterEach(cleanup);
async function mount(layout = template.layout) {
  const onClose = vi.fn();
  const view = render(
    <SurfaceScope kind="tab">
      <LayoutTemplates
        layout={layout}
        cardLabel={(id) => (id === "cpu" ? "CPU" : "Memory")}
        onClose={onClose}
        onApply={mocks.apply}
      />
    </SurfaceScope>,
  );
  await screen.findByRole("checkbox", { name: "Select Alpha" });
  return { ...view, onClose };
}
const choose = () =>
  fireEvent.change(screen.getByRole("combobox", { name: "Template" }), {
    target: { value: "1" },
  });
const applyButton = () =>
  screen.getByRole("button", { name: "Apply to selected hosts" });
describe("dashboard layout templates", () => {
  it("removes the mistaken health-card template action while preserving ordinary controls", async () => {
    render(
      <SurfaceScope kind="tab">
        <HealthCheckCard hostId={7} />
      </SurfaceScope>,
    );
    await waitFor(() => expect(mocks.managerGet).toHaveBeenCalled());
    expect(
      screen.queryByRole("button", { name: /templates/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "common.edit" }),
    ).toBeInTheDocument();
  });
  it("starts unselected, previews ordered cards and dimensions/settings, confirms replacement, then applies selected hosts only", async () => {
    await mount();
    expect(applyButton()).toBeDisabled();
    choose();
    const preview = screen.getByRole("region", { name: "Template preview" });
    expect(preview).toHaveTextContent("Cards: 2.");
    expect(preview.textContent!.indexOf("CPU")).toBeLessThan(
      preview.textContent!.indexOf("Memory"),
    );
    expect(preview).toHaveTextContent("6 of 12 columns");
    expect(preview).toHaveTextContent("1 column span");
    expect(preview).toHaveTextContent("480");
    expect(preview).toHaveTextContent("Graph size: Large");
    expect(preview).toHaveTextContent("Show details: Off");
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith(template, [7]),
    );
    const confirm = mocks.confirm.mock.calls[0][0];
    expect(confirm.destructive).toBe(true);
    const confirmation = render(confirm.description);
    expect(confirmation.container).toHaveTextContent(
      "Replace your dashboard layouts",
    );
    expect(confirmation.container).toHaveTextContent("Alpha (Production)");
    expect(confirmation.container).not.toHaveTextContent("Beta");
    expect(
      await screen.findByRole("region", { name: "Application results" }),
    ).toHaveTextContent("Dashboard layout replaced");
    expect(applyButton()).toBeDisabled();
  });
  it("saves a named snapshot of all presentation fields without applying it", async () => {
    await mount();
    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "  New dashboard  " },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save current layout as template" }),
    );
    await waitFor(() =>
      expect(mocks.createLayoutTemplate).toHaveBeenCalledWith({
        name: "New dashboard",
        layout: template.layout,
      }),
    );
    expect(screen.getByRole("combobox", { name: "Template" })).toHaveValue("2");
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("supports an empty dashboard snapshot and selects only hosts matching a folder search", async () => {
    await mount({ columns: 3, slots: [] });
    fireEvent.change(screen.getByLabelText("Template name"), {
      target: { value: "Empty dashboard" },
    });
    expect(
      screen.getByRole("button", { name: "Save current layout as template" }),
    ).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText("Find hosts by name or folder"), {
      target: { value: "staging" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Select shown hosts" }));
    choose();
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenCalledWith(template, [8]),
    );
  });
  it("reports partial success and retries failed hosts only", async () => {
    mocks.apply.mockResolvedValueOnce([
      { hostId: 7, applied: true },
      { hostId: 8, applied: false, error: "access_denied" },
    ]);
    await mount();
    choose();
    fireEvent.click(screen.getByRole("button", { name: "Select shown hosts" }));
    fireEvent.click(applyButton());
    expect(
      await screen.findByText(
        "Completed: 1; failed: 1. Failed hosts remain selected for retry.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select Alpha" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select Beta" })).toBeChecked();
    fireEvent.click(applyButton());
    await waitFor(() =>
      expect(mocks.apply).toHaveBeenLastCalledWith(template, [8]),
    );
  });
  it("honors cancellation for replacement and deletion", async () => {
    mocks.confirm.mockResolvedValue(false);
    await mount();
    choose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(applyButton());
    await waitFor(() => expect(applyButton()).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalledTimes(2));
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.deleteLayoutTemplate).not.toHaveBeenCalled();
  });
  it("shows an empty state and deletes the template without applying anything", async () => {
    await mount();
    choose();
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    expect(await screen.findByText("No templates yet")).toBeInTheDocument();
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("preserves selection and permits retry on request failure", async () => {
    mocks.apply.mockRejectedValueOnce(new Error("Unavailable"));
    await mount();
    choose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    fireEvent.click(applyButton());
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    expect(
      screen.getByRole("checkbox", { name: "Select Alpha" }),
    ).toBeChecked();
    fireEvent.click(applyButton());
    await waitFor(() => expect(mocks.apply).toHaveBeenCalledTimes(2));
  });
  it("prevents duplicate submissions and stale confirmation writes after unmount", async () => {
    let resolve!: (value: boolean) => void;
    mocks.confirm.mockReturnValue(
      new Promise<boolean>((done) => {
        resolve = done;
      }),
    );
    const { unmount } = await mount();
    choose();
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Alpha" }));
    const button = applyButton();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      resolve(true);
    });
    expect(mocks.apply).not.toHaveBeenCalled();
  });
  it("caps selection at 100 and reloads failed host lists without implicit selection", async () => {
    mocks.getLayoutTemplateHosts.mockRejectedValueOnce(
      new Error("Could not list hosts"),
    );
    render(
      <SurfaceScope kind="tab">
        <LayoutTemplates
          layout={template.layout}
          cardLabel={(id) => id}
          onClose={vi.fn()}
          onApply={mocks.apply}
        />
      </SurfaceScope>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not list hosts",
    );
    mocks.getLayoutTemplateHosts.mockResolvedValue(
      Array.from({ length: 101 }, (_, i) => ({
        id: i + 1,
        name: `Host ${i + 1}`,
        folder: null,
      })),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Reload templates and hosts" }),
    );
    await screen.findByRole("checkbox", { name: "Select Host 1" });
    expect(applyButton()).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Select shown hosts" }),
    ).toBeDisabled();
    const boxes = screen.getAllByRole("checkbox");
    for (const box of boxes.slice(0, 100)) fireEvent.click(box);
    expect(boxes[100]).toBeDisabled();
    fireEvent.click(boxes[0]);
    expect(boxes[100]).not.toBeDisabled();
  });
});
