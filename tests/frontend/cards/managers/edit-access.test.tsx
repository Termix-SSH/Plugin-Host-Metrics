import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  host: null as Record<string, unknown> | null,
  user: { userId: "u1", username: "u1", isAdmin: false },
  get: vi.fn(),
}));

vi.mock("@termix-ssh/plugin-sdk/frontend", async (original) => ({
  ...(await original<object>()),
  useHost: () => mocks.host,
  useCurrentUser: () => mocks.user,
  useTranslation: () => ({ t: (key: string) => key, language: "en" }),
  usePluginApi: () => ({
    get: mocks.get,
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }),
}));

import { useCanEditHost } from "../../../../src/frontend/cards/managers/useCanEditHost";
import { extractError } from "../../../../src/frontend/cards/managers/useManagerData";

afterEach(() => {
  cleanup();
  mocks.host = null;
  mocks.user = { userId: "u1", username: "u1", isAdmin: false };
});

const canEdit = () => renderHook(() => useCanEditHost(7)).result.current;

describe("useCanEditHost", () => {
  it("allows the owner", () => {
    mocks.host = { id: "7", isShared: false };
    expect(canEdit()).toBe(true);
  });

  it("allows edit and manage shares", () => {
    mocks.host = { id: "7", isShared: true, permissionLevel: "edit" };
    expect(canEdit()).toBe(true);
    mocks.host = { id: "7", isShared: true, permissionLevel: "manage" };
    expect(canEdit()).toBe(true);
  });

  it("refuses connect and view shares", () => {
    mocks.host = { id: "7", isShared: true, permissionLevel: "connect" };
    expect(canEdit()).toBe(false);
    mocks.host = { id: "7", isShared: true, permissionLevel: "view" };
    expect(canEdit()).toBe(false);
  });

  it("allows an admin on any host", () => {
    mocks.host = { id: "7", isShared: true, permissionLevel: "connect" };
    mocks.user = { ...mocks.user, isAdmin: true };
    expect(canEdit()).toBe(true);
  });
});

describe("edit access in the UI", () => {
  it("shows the translated message for an edit refusal", () => {
    const error = {
      response: {
        data: { error: "server text", code: "HOST_EDIT_REQUIRED" },
      },
    };
    expect(extractError(error, (key) => key).message).toBe(
      "hostMetrics.managers.editRequired",
    );
    expect(extractError(error).message).toBe("server text");
  });
});
