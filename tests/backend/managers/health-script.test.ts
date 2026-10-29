import { describe, expect, it } from "vitest";
import {
  numberLevel,
  parseChecks,
  parseScriptResult,
  type HealthCheck,
} from "../../../src/backend/managers/health.js";

const script = (extra: Partial<HealthCheck>): HealthCheck => ({
  id: "s1",
  name: "Audit log",
  type: "script",
  target: "",
  command: "df --output=pcent /var/log/audit | tail -1",
  kind: "number",
  ...extra,
});

describe("script checks", () => {
  it("are saved only with a name, a command and a kind", () => {
    const valid = script({ unit: "%", warn: 80, crit: 90 });
    expect(parseChecks(JSON.stringify([valid]))).toEqual([valid]);
    expect(parseChecks(JSON.stringify([script({ command: "" })]))).toEqual([]);
    expect(parseChecks(JSON.stringify([script({ name: " " })]))).toEqual([]);
    expect(
      parseChecks(JSON.stringify([script({ kind: "bogus" as never })])),
    ).toEqual([]);
    expect(
      parseChecks(JSON.stringify([script({ warn: "high" as never })])),
    ).toEqual([]);
  });

  it("reads the last number and compares it with the limits", () => {
    const check = script({ unit: "%", warn: 80, crit: 90 });
    const out = (stdout: string) =>
      parseScriptResult(check, { stdout, stderr: "", code: 0 });
    expect(out("Use%\n 42%\n")).toMatchObject({
      ok: true,
      level: "ok",
      value: 42,
      detail: "42%",
    });
    expect(out("85%")).toMatchObject({ ok: true, level: "warn" });
    expect(out("97%")).toMatchObject({ ok: false, level: "crit" });
    expect(out("nothing")).toMatchObject({ ok: false, value: null });
  });

  it("treats a low value as bad when below is set", () => {
    const check = script({ below: true, warn: 20, crit: 10 });
    expect(numberLevel(50, check)).toBe("ok");
    expect(numberLevel(15, check)).toBe("warn");
    expect(numberLevel(5, check)).toBe("crit");
  });

  it("passes a status check on exit code 0", () => {
    const check = script({ kind: "status", command: "systemctl is-active x" });
    expect(
      parseScriptResult(check, { stdout: "active\n", stderr: "", code: 0 }),
    ).toMatchObject({ ok: true, detail: "active" });
    expect(
      parseScriptResult(check, { stdout: "inactive\n", stderr: "", code: 3 }),
    ).toMatchObject({ ok: false, detail: "inactive", level: "crit" });
  });

  it("shows the first line of a text check", () => {
    const check = script({ kind: "text", command: "cat /etc/motd" });
    expect(
      parseScriptResult(check, {
        stdout: "\n  hello there \nsecond",
        stderr: "",
        code: 0,
      }),
    ).toMatchObject({ ok: true, detail: "hello there" });
  });
});
