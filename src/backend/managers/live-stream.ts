import { shellSingleQuote } from "@termix-ssh/plugin-sdk/host-commands";
import {
  liveCmd,
  parseLive,
  type LivePrev,
  type LiveSample,
} from "@termix-ssh/plugin-sdk/host-scripts";
import type { RunOnHost } from "./types.js";

// The SDK's awk program, so the stream always matches its parser. It holds no single quote.
const AWK = liveCmd(1).split("'")[1];

/**
 * One long-lived shell per viewed host prints a sample every `ms` and the
 * server keeps only the latest. Viewers read that cache, so the host runs one
 * awk (no process scan on most ticks) however many people watch.
 * shortcut: fractional sleep needs GNU or busybox sleep, and the loop may run one
 * extra tick after the channel closes; add a heartbeat if that ever matters.
 */
export const liveStreamCmd = (ms: number, procEvery: number) =>
  "sh -c " +
  shellSingleQuote(
    "pg=$(getconf PAGESIZE); n=0; while :; do if [ $((n % " +
      procEvery +
      ")) -eq 0 ]; then awk -v pg=$pg '" +
      AWK +
      "' /proc/[0-9]*/stat; else awk -v pg=$pg '" +
      AWK +
      "'; fi; echo '##END'; n=$((n+1)); sleep " +
      ms / 1000 +
      " 2>/dev/null || sleep 1; done",
  );

const IDLE_MS = 10_000;
const FAIL_RETRY_MS = 5000;
const MAX_BUF = 1_000_000;
const waitMs = (ms: number) => Math.max(5000, 2 * ms + 3000);

interface Slot {
  ms: number;
  started: number;
  want: Map<number, number>;
  prev?: LivePrev;
  /** Parser state at the last process scan, so process CPU spans scan to scan. */
  scan?: LivePrev;
  procs?: Pick<LiveSample, "count" | "running" | "procs">;
  sample?: LiveSample;
  at: number;
  count: number;
  seen: number;
  stopped: boolean;
  error?: Error;
  failedAt: number;
  waiters: { ok: () => void; bad: (e: Error) => void }[];
  close?: () => void;
}

/** Returns the freshest sample for a host, starting its stream on first use. */
export function createSamplers(runOnHost: RunOnHost) {
  const slots = new Map<number, Slot>();

  const drop = (hostId: number, slot: Slot) => {
    slot.stopped = true;
    slot.close?.();
    if (slots.get(hostId) === slot) slots.delete(hostId);
  };
  const fail = (slot: Slot, error: Error) => {
    if (slot.error) return;
    slot.error = error;
    slot.failedAt = Date.now();
    slot.stopped = true;
    for (const w of slot.waiters.splice(0)) w.bad(error);
    slot.close?.();
  };

  const start = (
    hostId: number,
    ms: number,
    want: Map<number, number>,
  ): Slot => {
    const slot: Slot = {
      ms,
      started: Date.now(),
      want,
      at: 0,
      count: 0,
      seen: Date.now(),
      stopped: false,
      failedAt: 0,
      waiters: [],
    };
    slots.set(hostId, slot);
    const procEvery = Math.max(1, Math.round(2000 / ms));
    runOnHost(
      hostId,
      "connect",
      (client) =>
        new Promise<void>((resolve) => {
          client.exec(liveStreamCmd(ms, procEvery), (err, stream) => {
            if (err || !stream) {
              fail(slot, err ?? new Error("live stream failed"));
              return resolve();
            }
            slot.close = () => stream.close();
            if (slot.stopped) stream.close();
            stream.stderr?.on("data", () => {});
            let buf = "";
            stream.on("data", (d: Buffer) => {
              buf += d.toString();
              if (buf.length > MAX_BUF) buf = "";
              let i: number;
              while ((i = buf.indexOf("##END\n")) >= 0) {
                const chunk = buf.slice(0, i);
                buf = buf.slice(i + 6);
                try {
                  const p = parseLive(chunk, slot.prev);
                  slot.prev = p.next;
                  // Fast ticks print no process section; keep the last scan's processes.
                  if (chunk.split("@@\n")[5]?.trim()) {
                    const s = parseLive(chunk, slot.scan);
                    slot.scan = s.next;
                    slot.procs = {
                      count: s.sample.count,
                      running: s.sample.running,
                      procs: s.sample.procs,
                    };
                  }
                  slot.sample = { ...p.sample, ...slot.procs };
                  slot.at = Date.now();
                  if (++slot.count >= 2)
                    for (const w of slot.waiters.splice(0)) w.ok();
                } catch (e) {
                  fail(slot, e as Error);
                }
              }
            });
            stream.on("close", () => {
              if (!slot.stopped) fail(slot, new Error("live stream closed"));
              resolve();
            });
          });
        }),
    ).catch((e) => {
      fail(slot, e as Error);
    });
    return slot;
  };

  const timer = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of slots) if (now - s.seen > IDLE_MS) drop(id, s);
  }, 2000);
  timer.unref?.();

  const sample = async (hostId: number, ms: number): Promise<LiveSample> => {
    const now = Date.now();
    let slot = slots.get(hostId);
    if (slot?.error && now - slot.failedAt < FAIL_RETRY_MS) throw slot.error;
    const want = slot?.want ?? new Map<number, number>();
    want.set(ms, now);
    for (const [k, t] of want) if (now - t > IDLE_MS) want.delete(k);
    const target = Math.min(...want.keys());
    // Faster demand, expired fast demand, failure, no first frames or a stall restarts the stream.
    if (
      slot &&
      (target < slot.ms ||
        target >= 2 * slot.ms ||
        slot.error ||
        (slot.count < 2 && now - slot.started > waitMs(slot.ms)) ||
        (slot.at > 0 && now - slot.at > Math.max(10_000, 4 * slot.ms)))
    ) {
      const pending = slot.waiters.splice(0);
      drop(hostId, slot);
      slot = start(hostId, target, want);
      slot.waiters.push(...pending);
    }
    slot ??= start(hostId, target, want);
    slot.seen = now;
    if (slot.count < 2) {
      const s = slot;
      await new Promise<void>((ok, bad) => {
        const w = {
          ok: () => (clearTimeout(t), ok()),
          bad: (e: Error) => (clearTimeout(t), bad(e)),
        };
        const t = setTimeout(() => {
          s.waiters = s.waiters.filter((x) => x !== w);
          bad(new Error("live stream timed out"));
        }, waitMs(s.ms));
        s.waiters.push(w);
      });
    }
    return slot.sample ?? s_fallback(slot);
  };
  const s_fallback = (slot: Slot): LiveSample => {
    throw slot.error ?? new Error("live stream stopped");
  };
  return Object.assign(sample, {
    dispose() {
      clearInterval(timer);
      for (const [id, s] of [...slots]) {
        for (const w of s.waiters.splice(0))
          w.bad(new Error("live stream stopped"));
        drop(id, s);
      }
    },
  });
}
