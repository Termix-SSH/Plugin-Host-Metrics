import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AnimatedGauge } from "../../src/frontend/cards/AnimatedGauge";

const arc = (c: HTMLElement) => c.querySelectorAll("circle")[1] as SVGElement;
const dash = (c: HTMLElement) =>
  Number(arc(c).getAttribute("stroke-dasharray")!.split(" ")[0]);
const flush = () =>
  act(async () => void (await new Promise((r) => setTimeout(r, 40))));

const motion = (reduce: boolean) =>
  vi.stubGlobal("matchMedia", (q: string) => ({
    matches: reduce && q.includes("reduce"),
  }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AnimatedGauge", () => {
  it("starts empty, then eases to the value with a transition", async () => {
    motion(false);
    const { container } = render(
      <AnimatedGauge value={50} colorClassName="text-amber-500" />,
    );
    expect(dash(container)).toBe(0);
    expect(arc(container).style.transition).toContain("stroke-dasharray");
    await flush();
    expect(dash(container)).toBeGreaterThan(0);
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  it("follows later values", async () => {
    motion(false);
    const { container, rerender } = render(
      <AnimatedGauge value={20} colorClassName="text-emerald-500" />,
    );
    await flush();
    const low = dash(container);
    rerender(<AnimatedGauge value={80} colorClassName="text-red-500" />);
    await flush();
    expect(dash(container)).toBeGreaterThan(low);
  });

  it("skips the animation when reduced motion is requested", () => {
    motion(true);
    const { container } = render(
      <AnimatedGauge value={50} colorClassName="text-amber-500" />,
    );
    expect(dash(container)).toBeGreaterThan(0);
    expect(arc(container).style.transition).toBe("none");
  });

  it("shows N/A with an empty arc when there is no data", async () => {
    motion(false);
    const { container } = render(
      <AnimatedGauge value={null} colorClassName="text-emerald-500" />,
    );
    await flush();
    expect(screen.getByText("N/A")).toBeInTheDocument();
    expect(dash(container)).toBe(0);
  });
});
