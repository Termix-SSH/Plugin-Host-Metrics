import { afterEach, describe, expect, it, vi } from "vitest";

const exec = vi.hoisted(() => vi.fn());
vi.mock("@termix-ssh/plugin-sdk/host-commands", async (orig) => ({
  ...(await orig<object>()),
  execCommand: exec,
}));
import { registerLiveRoutes } from "../../../src/backend/managers/live.js";

const OUT = [
  "cpu  10 0 0 90 0 0 0 0 0 0\ncpu0 10 0 0 90 0 0 0 0 0 0",
  "MemTotal: 1000 kB\nMemAvailable: 400 kB",
  "0.1 0.2 0.3 1/2 3\n100 5",
  "Inter-|",
  "4096",
  "1	5\t10\t7\tS\t0\tjava\n",
].join("\n@@\n");

function setup(config = { enabled: true, minSeconds: 2 }) {
  let handler: (req: unknown, res: unknown) => Promise<void>;
  const gates: Array<(...a: never[]) => unknown> = [];
  const app = {
    get: (_p: string, ...h: Array<(...a: never[]) => unknown>) => {
      gates.push(...h.slice(0, -1));
      handler = h[h.length - 1] as never;
    },
  };
  const access = { allowed: true };
  const runOnHost = vi.fn(async (_id, _lvl, fn) => {
    if (!access.allowed) throw new Error("denied");
    return fn({}, { id: 1, actorId: "u" });
  });
  registerLiveRoutes(
    app as never,
    {
      validateHostId: (_q: unknown, _r: unknown, n: () => void) => n(),
      liveConfig: async () => config,
      runOnHost,
      log: { error: vi.fn() },
    } as never,
  );
  const call = async () => {
    const res: Record<string, unknown> & { locals: Record<string, unknown> } = {
      locals: {},
      status: vi.fn(() => res),
      json: vi.fn(() => res),
    };
    const req = { params: { id: "1" }, res };
    let blocked = true;
    // gates[1] is the live-config gate; validateHostId is gates[0].
    await (gates[1] as never as (...a: unknown[]) => Promise<void>)(
      req,
      res,
      () => (blocked = false),
    );
    if (!blocked) await handler(req, res);
    return res;
  };
  return { call, runOnHost, access };
}

afterEach(() => {
  vi.useRealTimers();
  exec.mockReset();
});

describe("live route", () => {
  it("returns LIVE_DISABLED without borrowing SSH", async () => {
    const { call, runOnHost } = setup({ enabled: false, minSeconds: 2 });
    const res = await call();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "LIVE_DISABLED" }),
    );
    expect(runOnHost).not.toHaveBeenCalled();
  });

  it("enforces the full minimum, including values above the 60s cleanup", async () => {
    vi.useFakeTimers();
    exec.mockResolvedValue({ stdout: OUT, code: 0 });
    const { call } = setup({ enabled: true, minSeconds: 120 });
    await call();
    vi.advanceTimersByTime(61_000);
    await call();
    expect(exec).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    await call();
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("does not sample again at 90% of the minimum", async () => {
    vi.useFakeTimers();
    exec.mockResolvedValue({ stdout: OUT, code: 0 });
    const { call } = setup();
    await call();
    vi.advanceTimersByTime(1800);
    await call();
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("does not serve a cached sample to a caller without access", async () => {
    vi.useFakeTimers();
    exec.mockResolvedValue({ stdout: OUT, code: 0 });
    const { call, access } = setup();
    await call();
    access.allowed = false;
    const res = await call();
    // Denied callers never reach the cache, even right after an allowed one filled it.
    expect(res.json).toHaveBeenCalledWith({ error: "denied" });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("reports the current minimum on a cached response after the admin raises it", async () => {
    vi.useFakeTimers();
    exec.mockResolvedValue({ stdout: OUT, code: 0 });
    const config = { enabled: true, minSeconds: 2 };
    const { call } = setup(config);
    await call();
    config.minSeconds = 120;
    vi.advanceTimersByTime(1000);
    const res = await call();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ minIntervalS: 120 }),
    );
  });

  it("joins a sample that is still running", async () => {
    vi.useFakeTimers();
    let done!: (v: unknown) => void;
    exec.mockReturnValue(new Promise((r) => (done = r)));
    const { call } = setup();
    const a = call();
    await vi.advanceTimersByTimeAsync(5000);
    const b = call();
    done({ stdout: OUT, code: 0 });
    await Promise.all([a, b]);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("rejects output without /proc data instead of returning an empty sample", async () => {
    exec.mockResolvedValue({ stdout: "\n@@\n".repeat(5) + "4096\n", code: 0 });
    const { call } = setup();
    const res = await call();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
