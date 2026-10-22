import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { ServerMetrics } from "../../src/shared/metrics";

vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  MetricCard: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PanelSearch: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
  }) => (
    <input
      aria-label={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
import { ProcessesCard } from "../../src/frontend/cards/ProcessesCard";

const p = (pid: string, cpu: string, command: string) => ({
  pid,
  ppid: "1",
  state: "S",
  cpu,
  mem: "1",
  user: "",
  command,
});
const metrics = (top: ReturnType<typeof p>[]) =>
  ({ processes: { total: top.length, top } }) as unknown as ServerMetrics;

afterEach(cleanup);

describe("ProcessesCard", () => {
  it("keeps the search box when the list shrinks, so a filter can always be cleared", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      p(String(i + 10), "1", "svc" + i),
    );
    const { rerender } = render(<ProcessesCard metrics={metrics(many)} />);
    fireEvent.change(screen.getByLabelText("hostMetrics.processesSearch"), {
      target: { value: "svc19" },
    });
    rerender(<ProcessesCard metrics={metrics(many.slice(0, 5))} />);
    expect(screen.getByLabelText("hostMetrics.processesSearch")).toHaveValue(
      "svc19",
    );
    expect(
      screen.getByText("hostMetrics.processesNoMatch"),
    ).toBeInTheDocument();
  });

  it("marks the active sort column and changes it on click", () => {
    render(
      <ProcessesCard metrics={metrics([p("2", "1", "a"), p("3", "9", "b")])} />,
    );
    const cpu = screen.getByRole("columnheader", { name: "CPU%" });
    expect(cpu).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(screen.getByRole("button", { name: "PID" }));
    expect(screen.getByRole("columnheader", { name: "PID" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(cpu).toHaveAttribute("aria-sort", "none");
  });
});
