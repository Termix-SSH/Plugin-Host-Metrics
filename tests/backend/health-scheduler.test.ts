import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runChecks = vi.hoisted(() => vi.fn());
vi.mock("../../src/backend/managers/health.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../src/backend/managers/health.js")
  >()),
  runChecks,
}));

import {
  createHealthAlerts,
  HEALTH_TICK_MS,
  HealthScheduler,
} from "../../src/backend/health-scheduler.js";
import {
  createHealthRecorder,
  type HealthCheck,
} from "../../src/backend/managers/health.js";
import type { HealthChecksRow } from "../../src/backend/repository.js";

const check: HealthCheck = {
  id: "web",
  name: "Web",
  type: "tcp",
  target: "localhost",
  port: 80,
};

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function setup(
  options: {
    rows?: HealthChecksRow[];
    access?: boolean;
    metricsEnabled?: boolean;
    authType?: string;
  } = {},
) {
  const rows = options.rows ?? [
    {
      userId: "user-1",
      hostId: 7,
      checks: JSON.stringify([check]),
      intervalSeconds: 60,
    },
  ];
  const actors: string[] = [];
  let actor: string | undefined;
  const connections: number[] = [];
  const ctx = {
    asUser: async <T>(userId: string, fn: () => Promise<T> | T) => {
      const previous = actor;
      actor = userId;
      try {
        return await fn();
      } finally {
        actor = previous;
      }
    },
    hosts: {
      checkAccess: async () => {
        actors.push(actor!);
        return { hasAccess: options.access ?? true };
      },
    },
    ssh: {
      supportsBackground: (authType: string) => authType !== "totp",
      withConnection: async (
        host: { id: number },
        _options: unknown,
        fn: (client: unknown) => Promise<unknown>,
      ) => {
        connections.push(host.id);
        return fn({});
      },
    },
    schedule: {
      every: (ms: number, fn: () => void) => {
        const timer = setInterval(fn, ms);
        return () => clearInterval(timer);
      },
    },
  };
  const record = vi.fn(async () => {});
  const scheduler = new HealthScheduler({
    ctx: ctx as never,
    repository: {
      listAllChecks: async () => rows,
      findChecks: async (userId, hostId) =>
        rows.find((r) => r.userId === userId && r.hostId === hostId) ?? null,
    },
    poller: {
      resolve: async (hostId) =>
        ({
          id: hostId,
          userId: "user-1",
          ip: "10.0.0.7",
          port: 22,
          username: "root",
          authType: options.authType ?? "password",
          connectionType: "ssh",
        }) as never,
      settingsFor: async () => ({
        metricsEnabled: options.metricsEnabled ?? true,
      }),
    },
    record,
    log,
    random: () => 0,
  });
  return { scheduler, record, actors, connections, rows };
}

async function advance(ms: number, scheduler: HealthScheduler) {
  await vi.advanceTimersByTimeAsync(ms);
  await scheduler.drain();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
  runChecks.mockReset();
  runChecks.mockResolvedValue([
    { checkId: "web", ok: true, latencyMs: 3, detail: "open" },
  ]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("HealthScheduler", () => {
  it("runs each saved set on its interval as its owner", async () => {
    const { scheduler, record, actors } = setup();
    scheduler.start();

    await advance(HEALTH_TICK_MS, scheduler);
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      "user-1",
      7,
      [check],
      [expect.objectContaining({ checkId: "web", ok: true })],
    );
    expect(actors).toEqual(["user-1"]);

    // 60s interval: not again until a minute after the first run.
    await advance(HEALTH_TICK_MS * 3, scheduler);
    expect(record).toHaveBeenCalledTimes(1);
    await advance(HEALTH_TICK_MS, scheduler);
    expect(record).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it("never runs faster than the minimum interval", async () => {
    const { scheduler, record } = setup({
      rows: [
        {
          userId: "user-1",
          hostId: 7,
          checks: JSON.stringify([check]),
          intervalSeconds: 1,
        },
      ],
    });
    scheduler.start();
    await advance(HEALTH_TICK_MS, scheduler);
    await advance(HEALTH_TICK_MS, scheduler);
    expect(record).toHaveBeenCalledTimes(1);
    await advance(HEALTH_TICK_MS, scheduler);
    expect(record).toHaveBeenCalledTimes(2);
    scheduler.dispose();
  });

  it.each([
    ["the owner lost access", { access: false }],
    ["metrics are off for the host", { metricsEnabled: false }],
    ["the host needs an interactive login", { authType: "totp" }],
  ])("skips a host when %s", async (_label, options) => {
    const { scheduler, record, connections } = setup(options);
    scheduler.start();
    await advance(HEALTH_TICK_MS, scheduler);
    expect(connections).toEqual([]);
    expect(record).not.toHaveBeenCalled();
    scheduler.dispose();
  });

  it("skips a host with no checks", async () => {
    const { scheduler, connections } = setup({
      rows: [
        { userId: "user-1", hostId: 7, checks: "[]", intervalSeconds: 60 },
      ],
    });
    scheduler.start();
    await advance(HEALTH_TICK_MS, scheduler);
    expect(connections).toEqual([]);
    scheduler.dispose();
  });

  it("does not start a set again while it is still running", async () => {
    let release: () => void = () => {};
    runChecks.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve([{ checkId: "web", ok: true, latencyMs: 1, detail: "" }]);
        }),
    );
    const { scheduler, connections } = setup({
      rows: [
        {
          userId: "user-1",
          hostId: 7,
          checks: JSON.stringify([check]),
          intervalSeconds: 30,
        },
      ],
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(HEALTH_TICK_MS * 6);
    expect(connections).toEqual([7]);
    release();
    await scheduler.drain();
    scheduler.dispose();
  });

  it("stops ticking once disposed", async () => {
    const { scheduler, record } = setup();
    scheduler.start();
    scheduler.dispose();
    await advance(HEALTH_TICK_MS * 4, scheduler);
    expect(record).not.toHaveBeenCalled();
  });

  it("keeps going when one run fails", async () => {
    runChecks.mockRejectedValueOnce(new Error("boom"));
    const { scheduler, record } = setup({
      rows: [
        {
          userId: "user-1",
          hostId: 7,
          checks: JSON.stringify([check]),
          intervalSeconds: 30,
        },
      ],
    });
    scheduler.start();
    await advance(HEALTH_TICK_MS, scheduler);
    expect(record).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
    await advance(HEALTH_TICK_MS * 2, scheduler);
    expect(record).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });
});

describe("createHealthRecorder", () => {
  function recorder(previous: boolean | null) {
    const repository = {
      listHealth: vi.fn(async () =>
        previous === null
          ? []
          : [
              {
                checkId: "web",
                ts: "2026-10-01 00:00:00",
                ok: previous,
                latencyMs: 1,
                detail: null,
              },
            ],
      ),
      recordHealth: vi.fn(async () => {}),
    };
    const onHealthCheck = vi.fn();
    const onChange = vi.fn(async () => {});
    const record = createHealthRecorder({
      repository: repository as never,
      onHealthCheck,
      onChange,
    });
    return { record, repository, onHealthCheck, onChange };
  }

  it("stores results and reports a flip", async () => {
    const { record, repository, onHealthCheck, onChange } = recorder(true);
    const result = { checkId: "web", ok: false, latencyMs: null, detail: "x" };
    await record("user-1", 7, [check], [result]);
    expect(repository.recordHealth).toHaveBeenCalledWith(
      "user-1",
      7,
      [result],
      500,
    );
    expect(onHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 7, checkId: "web", ok: false }),
    );
    expect(onChange).toHaveBeenCalledWith({
      userId: "user-1",
      hostId: 7,
      check,
      result,
    });
  });

  it.each([
    ["the state did not change", true],
    ["there is no earlier result", null],
  ])("does not report when %s", async (_label, previous) => {
    const { record, onChange } = recorder(previous);
    await record(
      "user-1",
      7,
      [check],
      [{ checkId: "web", ok: true, latencyMs: 1, detail: "" }],
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("createHealthAlerts", () => {
  it("alerts the check's owner when a check fails and recovers", async () => {
    const send = vi.fn(async () => ({
      recipients: 1,
      delivered: 0,
      failures: [],
    }));
    const alert = createHealthAlerts(
      {
        asUser: async (_userId: string, fn: () => unknown) => fn(),
        hosts: { get: async () => ({ name: "web-1" }) },
        notify: { send },
      } as never,
      log,
    );
    await alert({
      userId: "user-1",
      hostId: 7,
      check,
      result: { checkId: "web", ok: false, latencyMs: null, detail: "closed" },
    });
    await alert({
      userId: "user-1",
      hostId: 7,
      check,
      result: { checkId: "web", ok: true, latencyMs: 2, detail: "open" },
    });
    expect(send).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        title: "Web is failing on web-1",
        severity: "warning",
        category: "host-metrics.health_failed",
        audience: { userId: "user-1" },
      }),
    );
    expect(send).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        severity: "success",
        category: "host-metrics.health_recovered",
      }),
    );
  });

  it("never throws when sending fails", async () => {
    const alert = createHealthAlerts(
      {
        asUser: async (_userId: string, fn: () => unknown) => fn(),
        hosts: { get: async () => null },
        notify: {
          send: async () => {
            throw new Error("no hub");
          },
        },
      } as never,
      log,
    );
    await expect(
      alert({
        userId: "user-1",
        hostId: 7,
        check,
        result: { checkId: "web", ok: false, latencyMs: null, detail: "" },
      }),
    ).resolves.toBeUndefined();
  });
});
