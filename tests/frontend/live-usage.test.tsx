import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

const chart = vi.fn();
vi.mock("../../src/frontend/cards/SmoothCharts", () => ({
  SmoothLineChart: (props: unknown) => {
    chart(props);
    return null;
  },
}));

import { LiveUsage } from "../../src/frontend/cards/LiveUsage";

describe("LiveUsage", () => {
  it("starts the line at the first reading that has a value", () => {
    render(
      <LiveUsage
        percent={12}
        stats={[]}
        label="CPU"
        color="red"
        points={[null, 10, 12]}
        timestamps={["a", "b", "c"]}
        chartHeight={100}
      />,
    );
    const props = chart.mock.calls.at(-1)?.[0] as {
      series: Array<{ data: Array<number | null> }>;
      timestamps: string[];
    };
    expect(props.series[0].data).toEqual([10, 12]);
    expect(props.timestamps).toEqual(["b", "c"]);
  });

  it("shows a placeholder until there are two readings", () => {
    chart.mockClear();
    const { getByText } = render(
      <LiveUsage
        percent={null}
        stats={[]}
        label="CPU"
        color="red"
        points={[null, 4]}
        timestamps={["a", "b"]}
        chartHeight={100}
      />,
    );
    expect(chart).not.toHaveBeenCalled();
    expect(getByText("hostMetrics.collecting")).toBeTruthy();
  });
});
