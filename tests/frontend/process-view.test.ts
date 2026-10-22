import { describe, expect, it } from "vitest";
import { loadColor, viewProcesses } from "../../src/frontend/process-view";

const p = (pid: string, ppid: string, cpu: string, command = "x" + pid) => ({
  pid,
  ppid,
  cpu,
  mem: "1",
  user: "",
  command,
});
const list = [
  p("1", "0", "1"),
  p("2", "1", "9"),
  p("3", "1", "5"),
  p("4", "3", "7"),
];

describe("viewProcesses", () => {
  it("sorts by cpu and filters by name or pid", () => {
    expect(
      viewProcesses(list, "cpu", "", false).map((r) => r.proc.pid),
    ).toEqual(["2", "4", "3", "1"]);
    expect(viewProcesses(list, "cpu", "x3", false)).toHaveLength(1);
    expect(viewProcesses(list, "cpu", "4", false)).toHaveLength(1);
  });
  it("nests children under parents, busiest sibling first", () => {
    const rows = viewProcesses(list, "cpu", "", true);
    expect(rows.map((r) => [r.proc.pid, r.depth])).toEqual([
      ["1", 0],
      ["2", 1],
      ["3", 1],
      ["4", 2],
    ]);
  });
  it("treats a parent outside the list as a root and still shows a parent loop", () => {
    const cyc = [p("5", "6", "1"), p("6", "5", "2"), p("7", "99", "3")];
    const rows = viewProcesses(cyc, "cpu", "", true);
    expect(rows.map((r) => r.proc.pid).sort()).toEqual(["5", "6", "7"]);
  });
});
describe("loadColor", () => {
  it("goes green, amber, red", () => {
    expect(loadColor(10)).toContain("accent-brand");
    expect(loadColor(60)).toContain("amber");
    expect(loadColor(95)).toContain("red");
  });
});
