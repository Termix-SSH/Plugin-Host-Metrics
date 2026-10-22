import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
}));
const remote = vi.hoisted(() => ({
  live: null as null | {
    cpu: number | null;
    memUsedKb: number;
    memTotalKb: number;
  },
  liveActive: [] as boolean[],
  api: { get: vi.fn(), post: vi.fn() },
  origin: "local" as "local" | "remote",
  remoteId: 70 as number | null,
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  usePluginApi: () => api,
  usePluginApiFor: () => remote.api,
  useSettings: () => ({ values: {} }),
  useTranslation: () => ({ t: (key: string) => key, language: "en" }),
}));

vi.mock("../../src/frontend/live-metrics", () => ({
  liveIntervalMs: () => 2000,
  useLiveMetrics: (_id: unknown, active: boolean) => {
    remote.liveActive.push(active);
    return active ? remote.live : null;
  },
}));

vi.mock("@termix-ssh/plugin-sdk/ui", () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(" "),
  getPollingEnvironmentMultiplier: () => 1,
  resolveConnectionOrigin: async () => remote.origin,
  resolveRemoteHostId: async () => remote.remoteId,
  runAdaptivePolling: (poll: () => Promise<unknown>) => {
    void poll();
    return () => {};
  },
}));

import { TerminalMetricsStatus } from "../../src/frontend/TerminalMetricsStatus";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  remote.origin = "local";
  remote.remoteId = 70;
  remote.live = null;
  remote.liveActive = [];
});

describe("TerminalMetricsStatus", () => {
  it("polls the host's metrics while active and shows the bars", async () => {
    api.post.mockResolvedValue({ data: { viewerSessionId: "viewer-1" } });
    api.get.mockResolvedValue({
      data: {
        cpu: { percent: 12 },
        memory: { percent: 40 },
        disk: { percent: 91 },
      },
    });

    render(<TerminalMetricsStatus host={{ id: 7 }} isConnected active />);

    await waitFor(() => expect(screen.getByText("91%")).toBeInTheDocument());
    expect(api.post).toHaveBeenCalledWith("/metrics/start/7");
    expect(screen.getByText("12%")).toBeInTheDocument();
    expect(screen.getByText("hostMetrics.cpu")).toBeInTheDocument();
  });

  it("shows the live CPU and memory over the regular sample, and keeps disk", async () => {
    api.post.mockResolvedValue({ data: { viewerSessionId: "viewer-3" } });
    api.get.mockResolvedValue({
      data: {
        cpu: { percent: 12 },
        memory: { percent: 40 },
        disk: { percent: 91 },
      },
    });
    remote.live = { cpu: 77.4, memUsedKb: 250, memTotalKb: 1000 };
    render(<TerminalMetricsStatus host={{ id: 7 }} isConnected active />);
    await waitFor(() => expect(screen.getByText("91%")).toBeInTheDocument());
    expect(screen.getByText("77%")).toBeInTheDocument();
    expect(screen.getByText("25%")).toBeInTheDocument();
    expect(screen.queryByText("12%")).not.toBeInTheDocument();
  });

  it("does not run live updates for a host on the remote server", async () => {
    remote.origin = "remote";
    remote.api.post.mockResolvedValue({ data: { viewerSessionId: "v" } });
    remote.api.get.mockResolvedValue({ data: null });
    render(
      <TerminalMetricsStatus
        host={{ id: 7, syncId: "s" }}
        isConnected
        active
      />,
    );
    await waitFor(() => expect(remote.api.post).toHaveBeenCalled());
    // Never enabled, not even while the origin was still being resolved.
    expect(remote.liveActive).not.toContain(true);
  });

  it("starts live updates only after the host is known to be local", async () => {
    api.post.mockResolvedValue({ data: { viewerSessionId: "v" } });
    api.get.mockResolvedValue({ data: null });
    render(<TerminalMetricsStatus host={{ id: 7 }} isConnected active />);
    expect(remote.liveActive[0]).toBe(false);
    await waitFor(() => expect(remote.liveActive).toContain(true));
  });

  it("does not enable live updates for a new remote host after a local one", async () => {
    api.post.mockResolvedValue({ data: { viewerSessionId: "v" } });
    api.get.mockResolvedValue({ data: null });
    remote.api.post.mockResolvedValue({ data: { viewerSessionId: "r" } });
    remote.api.get.mockResolvedValue({ data: null });
    const { rerender } = render(
      <TerminalMetricsStatus host={{ id: 7 }} isConnected active />,
    );
    await waitFor(() => expect(remote.liveActive).toContain(true));
    remote.origin = "remote";
    remote.liveActive = [];
    rerender(
      <TerminalMetricsStatus
        host={{ id: 8, syncId: "s" }}
        isConnected
        active
      />,
    );
    await waitFor(() => expect(remote.api.post).toHaveBeenCalled());
    expect(remote.liveActive).not.toContain(true);
  });

  it("does not poll while inactive", () => {
    render(
      <TerminalMetricsStatus host={{ id: 7 }} isConnected active={false} />,
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says stats are unavailable when the host needs a second factor", async () => {
    api.post.mockResolvedValue({ data: { requires_totp: true } });
    render(<TerminalMetricsStatus host={{ id: 7 }} isConnected active />);
    await waitFor(() =>
      expect(
        screen.getByText("terminalStatus.unavailable"),
      ).toBeInTheDocument(),
    );
  });

  it("stops its viewer on unmount", async () => {
    api.post.mockResolvedValue({ data: { viewerSessionId: "viewer-2" } });
    api.get.mockResolvedValue({ data: null });
    const view = render(
      <TerminalMetricsStatus host={{ id: 7 }} isConnected active />,
    );
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    view.unmount();
    expect(api.post).toHaveBeenLastCalledWith("/metrics/stop/7", {
      viewerSessionId: "viewer-2",
    });
  });

  it("polls a remote server's host by its id there", async () => {
    remote.origin = "remote";
    remote.api.post.mockResolvedValue({ data: { viewerSessionId: "v" } });
    remote.api.get.mockResolvedValue({ data: { cpu: { percent: 33 } } });

    render(
      <TerminalMetricsStatus
        host={{ id: 7, connectionOrigin: "remote", syncId: "s-1" }}
        isConnected
        active
      />,
    );

    await waitFor(() => expect(screen.getByText("33%")).toBeInTheDocument());
    expect(remote.api.post).toHaveBeenCalledWith("/metrics/start/70");
    expect(api.post).not.toHaveBeenCalled();
  });
});
