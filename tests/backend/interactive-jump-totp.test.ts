import { describe, expect, it, vi } from "vitest";
import type { PluginSsh } from "@termix-ssh/plugin-sdk/backend";
import { startInteractive } from "../../src/backend/interactive.js";
import type { MetricsHost } from "../../src/backend/helpers.js";

describe("startInteractive with an encrypted key", () => {
  const host = { id: 7, ip: "h", port: 22, username: "u" } as never;
  const deps = (prepare: unknown) => ({
    ssh: { prepare } as unknown as PluginSsh,
    sessions: { get: () => undefined } as never,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    registerViewer: vi.fn(),
  });

  it("asks for the passphrase and does not report an error", async () => {
    const prepare = vi.fn(async () => ({
      config: {},
      outcome: {
        status: "error",
        code: "passphrase-required",
        message: "The SSH key is encrypted.",
      },
    }));
    const result = await startInteractive(deps(prepare), host, "user");
    expect(result.status).toBe(200);
    expect(result.body.status).toBe("passphrase_required");
  });

  it("uses the typed passphrase for this connection", async () => {
    const prepare = vi.fn(async (_host: unknown, _options: unknown) => ({
      config: {},
      outcome: {
        status: "error",
        code: "passphrase-required",
        message: "wrong",
      },
    }));
    await startInteractive(deps(prepare), host, "user", "secret");
    expect(prepare.mock.calls[0]![0]).toMatchObject({ keyPassword: "secret" });
  });
});

describe("startInteractive through a jump host", () => {
  it("returns requires_totp when a jump host asks for a code", async () => {
    let answer: Promise<string | null> | null = null;
    const ssh = {
      prepare: vi.fn(async () => ({
        config: {},
        outcome: { status: "ready" },
      })),
      openTransport: vi.fn(
        (
          _host: unknown,
          _config: unknown,
          options?: {
            prompt?: { ask: (r: unknown) => Promise<string | null> };
          },
        ) => {
          answer = options!.prompt!.ask({
            kind: "totp",
            prompt: "Verification code:",
            retry: false,
          });
          return new Promise(() => {});
        },
      ),
    } as unknown as PluginSsh;
    const pending: Array<{ finish: (r: string[]) => void }> = [];
    const sessions = {
      get: () => undefined,
      addPending: (session: { finish: (r: string[]) => void }) =>
        pending.push(session),
    };
    const result = await startInteractive(
      {
        ssh,
        sessions: sessions as never,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
        registerViewer: vi.fn(),
      },
      {
        id: 7,
        ip: "10.0.0.1",
        port: 22,
        jumpHosts: [{ hostId: 2 }],
      } as MetricsHost,
      "u1",
    );

    expect(result.body).toMatchObject({
      requires_totp: true,
      prompt: "Verification code:",
    });
    pending[0].finish(["123456"]);
    await expect(answer).resolves.toBe("123456");
  });
});
