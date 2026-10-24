import { describe, expect, it, vi } from "vitest";

const sample = vi.hoisted(() => vi.fn());
vi.mock("../../../src/backend/managers/live-stream.js", () => ({
  createSamplers: () => sample,
}));
import { registerLiveRoutes } from "../../../src/backend/managers/live.js";

async function call(query: Record<string, string>, minMs = 500) {
  let handler: (req: unknown, res: unknown) => Promise<void>;
  const app = {
    get: (_p: string, ...h: Array<(...a: never[]) => unknown>) => {
      handler = h[h.length - 1] as never;
    },
  };
  registerLiveRoutes(
    app as never,
    {
      validateHostId: (_q: unknown, _r: unknown, n: () => void) => n(),
      liveConfig: async () => ({ enabled: true, minSeconds: minMs / 1000 }),
      runOnHost: async (
        _id: number,
        _l: string,
        fn: (...a: unknown[]) => unknown,
      ) => fn({}, { id: 1, actorId: "u" }),
      log: { error: vi.fn() },
    } as never,
  );
  const res: Record<string, unknown> & { locals: Record<string, unknown> } = {
    locals: { liveMinMs: minMs },
    status: vi.fn(() => res),
    json: vi.fn(() => res),
  };
  await handler!({ params: { id: "1" }, query, res }, res);
  return res;
}

describe("live route ?stream", () => {
  it("clamps ms to [min, 5000] and reports minIntervalS", async () => {
    sample.mockResolvedValue({ cores: [] });
    for (const [ms, want] of [
      ["100", 500],
      ["1000", 1000],
      ["99999", 5000],
    ] as const) {
      sample.mockClear();
      const res = await call({ stream: "1", ms });
      expect(sample).toHaveBeenCalledWith(1, want);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ minIntervalS: 0.5 }),
      );
    }
  });

  it("keeps an admin minimum above 5s", async () => {
    sample.mockResolvedValue({ cores: [] });
    sample.mockClear();
    await call({ stream: "1", ms: "99999" }, 10_000);
    expect(sample).toHaveBeenCalledWith(1, 10_000);
  });
});
