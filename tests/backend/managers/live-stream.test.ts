import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSamplers,
  liveStreamCmd,
} from "../../../src/backend/managers/live-stream.js";

const CHUNK = [
  "cpu  10 0 0 90 0 0 0 0 0 0\ncpu0 10 0 0 90 0 0 0 0 0 0",
  "MemTotal: 1000 kB\nMemAvailable: 400 kB",
  "0.1 0.2 0.3 1/2 3\n100 5",
  "Inter-|",
  "4096",
  "",
].join("\n@@\n");

function fake() {
  const streams: (EventEmitter & { close: () => void })[] = [];
  const client = {
    exec: vi.fn((_cmd: string, cb: (e: unknown, s: unknown) => void) => {
      const s = Object.assign(new EventEmitter(), {
        close: vi.fn(function (this: EventEmitter) {
          this.emit("close");
        }),
      });
      streams.push(s as never);
      cb(undefined, s);
    }),
  };
  const runOnHost = vi.fn(async (_id: number, _l: string, fn: never) =>
    (fn as (c: unknown, h: unknown) => Promise<void>)(client, {}),
  );
  return { streams, client, runOnHost };
}
const emit = (s: EventEmitter, n: number) => {
  for (let i = 0; i < n; i++) s.emit("data", Buffer.from(CHUNK + "##END\n"));
};

afterEach(() => vi.useRealTimers());

describe("liveStreamCmd", () => {
  it("wraps one loop with a process scan every Nth tick", () => {
    const c = liveStreamCmd(500, 4);
    expect(c).toMatch(/^sh -c '/);
    expect(c).toContain("n % 4");
    expect(c).toContain("sleep 0.5");
    expect(c).toContain("|| sleep 1;");
    expect(c).toContain("/proc/[0-9]*/stat");
  });
});

describe("createSamplers", () => {
  it("shares one stream between callers and splits partial chunks", async () => {
    const f = fake();
    const get = createSamplers(f.runOnHost as never);
    const a = get(1, 500);
    const b = get(1, 500);
    await Promise.resolve();
    const full = CHUNK + "##END\n";
    f.streams[0].emit("data", Buffer.from(full.slice(0, 20)));
    f.streams[0].emit("data", Buffer.from(full.slice(20)));
    emit(f.streams[0], 1);
    const [sa, sb] = await Promise.all([a, b]);
    expect(f.client.exec).toHaveBeenCalledTimes(1);
    expect(sa).toBe(sb);
    expect(sa.memTotalKb).toBe(1000);
  });

  it("restarts for a faster rate and after an error past the backoff", async () => {
    vi.useFakeTimers();
    const f = fake();
    const get = createSamplers(f.runOnHost as never);
    const p = get(1, 1000);
    await vi.advanceTimersByTimeAsync(0);
    emit(f.streams[0], 2);
    await p;
    const q = get(1, 250);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.exec).toHaveBeenCalledTimes(2);
    emit(f.streams[1], 2);
    await q;
    f.streams[1].emit("close");
    await expect(get(1, 250)).rejects.toThrow("closed");
    await vi.advanceTimersByTimeAsync(5001);
    const r = get(1, 250);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.exec).toHaveBeenCalledTimes(3);
    emit(f.streams[2], 2);
    await r;
  });

  it("drops an idle host's stream", async () => {
    vi.useFakeTimers();
    const f = fake();
    const get = createSamplers(f.runOnHost as never);
    const p = get(1, 1000);
    await vi.advanceTimersByTimeAsync(0);
    emit(f.streams[0], 2);
    await p;
    await vi.advanceTimersByTimeAsync(13_000);
    expect(f.streams[0].close).toHaveBeenCalled();
  });

  it("restarts a slower stream once fast demand expires", async () => {
    vi.useFakeTimers();
    const f = fake();
    const get = createSamplers(f.runOnHost as never);
    const p = get(1, 250);
    await vi.advanceTimersByTimeAsync(0);
    emit(f.streams[0], 2);
    await p;
    await vi.advanceTimersByTimeAsync(9000);
    const q = get(1, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.exec).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    const r = get(1, 1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.exec).toHaveBeenCalledTimes(2);
    emit(f.streams[1], 2);
    await Promise.all([q, r]);
  });

  it("a 5s rate waits past 5s for its first frames", async () => {
    vi.useFakeTimers();
    const f = fake();
    const get = createSamplers(f.runOnHost as never);
    const p = get(1, 5000);
    await vi.advanceTimersByTimeAsync(9000);
    emit(f.streams[0], 2);
    expect(await p).toHaveProperty("memTotalKb");
  });

  it("dispose closes streams and rejects waiters", async () => {
    vi.useFakeTimers();
    const f = fake();
    const get = createSamplers(f.runOnHost as never);
    const p = get(1, 1000).catch((e) => e);
    await vi.advanceTimersByTimeAsync(0);
    get.dispose();
    expect(f.streams[0].close).toHaveBeenCalled();
    expect(String(await p)).toContain("stopped");
  });
});
