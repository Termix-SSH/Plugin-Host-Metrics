import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "ssh2";
import { parseSwapMeminfo } from "../../../src/shared/swap.js";
import { collectSwapMetrics } from "../../../src/backend/widgets/swap-collector.js";

const exec = vi.hoisted(() => vi.fn());
vi.mock("@termix-ssh/plugin-sdk/host-commands", () => ({ execCommand: exec }));

const client = {} as Client;
const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() => vi.clearAllMocks());

describe("swap collection", () => {
  it("calculates precise byte counts, including sub-MiB usage", () => {
    expect(
      parseSwapMeminfo("SwapTotal: 1048572 kB\nSwapFree: 1048508 kB\n"),
    ).toEqual({
      totalBytes: 1073737728,
      usedBytes: 65536,
      freeBytes: 1073672192,
      percent: (64 / 1048572) * 100,
    });
  });

  it("distinguishes no swap from an unused configured swap", () => {
    expect(parseSwapMeminfo("SwapTotal: 0 kB\nSwapFree: 0 kB")).toEqual({
      totalBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      percent: null,
    });
    expect(
      parseSwapMeminfo("SwapTotal: 100 kB\nSwapFree: 100 kB").percent,
    ).toBe(0);
    expect(parseSwapMeminfo("SwapTotal: 100 kB\nSwapFree: 0 kB").percent).toBe(
      100,
    );
  });

  it.each([
    "",
    "SwapTotal: 10 kB",
    "SwapTotal: -1 kB\nSwapFree: 0 kB",
    "SwapTotal: 1.5 kB\nSwapFree: 0 kB",
    "SwapTotal: 10 MB\nSwapFree: 0 kB",
    "SwapTotal: 10 kB\nSwapFree: 11 kB",
    "SwapTotal: 9007199254740991 kB\nSwapFree: 0 kB",
    "SwapTotal: 10 kB\nSwapTotal: 20 kB\nSwapFree: 0 kB",
    "SwapTotal: 10 kB\nSwapTotal: invalid\nSwapFree: 0 kB",
    "SwapTotal: 10 kB\nSwapFree: 0 kB\nSwapFree: invalid",
  ])("rejects malformed or inconsistent readings: %s", (text) => {
    expect(() => parseSwapMeminfo(text)).toThrow();
  });

  it("collects Linux metrics read-only", async () => {
    exec.mockResolvedValue({
      code: 0,
      stdout: "SwapTotal: 100 kB\nSwapFree: 75 kB",
    });
    expect(await collectSwapMetrics(client, "linux", log)).toMatchObject({
      percent: 25,
    });
    expect(exec).toHaveBeenCalledWith(client, "cat /proc/meminfo");
  });

  it.each(["darwin", "windows", "other"] as const)(
    "marks %s unsupported without executing a command",
    async (platform) => {
      expect(await collectSwapMetrics(client, platform, log)).toBeNull();
      expect(exec).not.toHaveBeenCalled();
    },
  );

  it.each([
    { code: 1, stdout: "" },
    { code: 0, stdout: "SwapTotal: 5 kB\nSwapFree: 10 kB" },
  ])(
    "reports unavailable metrics and logs failed/invalid collection",
    async (result) => {
      exec.mockResolvedValue(result);
      expect(await collectSwapMetrics(client, "linux", log)).toBeNull();
      expect(log.warn).toHaveBeenCalledWith(
        "Swap metrics unavailable",
        expect.objectContaining({ error: expect.any(String) }),
      );
    },
  );
});
