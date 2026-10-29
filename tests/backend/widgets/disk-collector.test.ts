import { describe, it, expect } from "vitest";
import {
  selectPrimaryFilesystem,
  parseWindowsDiskJson,
  parseDarwinMountTypes,
  parseDarwinDfRows,
} from "../../../src/backend/widgets/disk-collector.js";

// The Linux df parsing is tested in the SDK, where it lives now.

// Representative output shape from `df -Pk` and `mount` on a modern macOS
// (Sonoma/Sequoia, Apple Silicon) system, where the APFS root volume group
// surfaces as several synthetic system volumes alongside the real "/" and
// "/System/Volumes/Data" mounts.
const DARWIN_DF_OUTPUT =
  "Filesystem   1024-blocks      Used Available Capacity Mounted on\n" +
  "/dev/disk3s1s1  971350180  10904432 723545416    2%    /\n" +
  "devfs                 205       205         0  100%    /dev\n" +
  "/dev/disk3s6    971350180   8437248 723545416    2%    /System/Volumes/VM\n" +
  "/dev/disk3s2    971350180   6067864 723545416    1%    /System/Volumes/Preboot\n" +
  "/dev/disk3s4    971350180     16612 723545416    1%    /System/Volumes/Update\n" +
  "/dev/disk1s2         500098      6104    479950    2%    /System/Volumes/xarts\n" +
  "/dev/disk1s1         500098      5388    479950    2%    /System/Volumes/iSCPreboot\n" +
  "/dev/disk1s3         500098        36    479950    1%    /System/Volumes/Hardware\n" +
  "/dev/disk3s5    971350180 235925064 723545416   25%    /System/Volumes/Data\n" +
  "map auto_home             0         0         0  100%    /System/Volumes/Data/home\n";

const DARWIN_MOUNT_OUTPUT =
  "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)\n" +
  "devfs on /dev (devfs, local, nobrowse)\n" +
  "/dev/disk3s6 on /System/Volumes/VM (apfs, local, noexec, journaled, noatime, nobrowse)\n" +
  "/dev/disk3s2 on /System/Volumes/Preboot (apfs, local, journaled, nobrowse)\n" +
  "/dev/disk3s4 on /System/Volumes/Update (apfs, local, journaled, nobrowse)\n" +
  "/dev/disk1s2 on /System/Volumes/xarts (apfs, local, noexec, journaled, noatime, nobrowse)\n" +
  "/dev/disk1s1 on /System/Volumes/iSCPreboot (apfs, local, journaled, nobrowse)\n" +
  "/dev/disk1s3 on /System/Volumes/Hardware (apfs, local, journaled, nobrowse)\n" +
  "/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)\n" +
  "map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)\n";

describe("parseDarwinMountTypes", () => {
  it("maps each mount point to its filesystem type", () => {
    const map = parseDarwinMountTypes(DARWIN_MOUNT_OUTPUT);
    expect(map.get("/")).toBe("apfs");
    expect(map.get("/dev")).toBe("devfs");
    expect(map.get("/System/Volumes/Data/home")).toBe("autofs");
  });
});

describe("parseDarwinDfRows", () => {
  it("parses real `df -Pk` rows and drops devfs/autofs and synthetic system volumes", () => {
    const typeByMount = parseDarwinMountTypes(DARWIN_MOUNT_OUTPUT);
    const rows = parseDarwinDfRows(DARWIN_DF_OUTPUT, typeByMount);

    expect(rows.map((r) => r.mount)).toEqual(["/", "/System/Volumes/Data"]);

    const root = rows[0];
    expect(root.type).toBe("apfs");
    expect(root.totalBytes).toBe(971350180 * 1024);
    expect(root.usedBytes).toBe(10904432 * 1024);
    expect(root.availableBytes).toBe(723545416 * 1024);
    expect(root.percent).toBe(1);
    expect(root.usedHuman).toBeTruthy();
    expect(root.totalHuman).toBeTruthy();
  });

  it("matches df's Capacity for volumes sharing an APFS container", () => {
    const rows = parseDarwinDfRows(
      "/dev/disk3s1s1 239362496 12262808 70690144 15% /\n" +
        "/dev/disk3s5 239362496 139671936 70690144 67% /System/Volumes/Data\n",
      new Map(),
    );
    expect(rows.map((r) => r.percent)).toEqual([15, 66]);
  });

  it("picks the data volume over the sealed system volume", () => {
    const typeByMount = parseDarwinMountTypes(DARWIN_MOUNT_OUTPUT);
    const rows = parseDarwinDfRows(DARWIN_DF_OUTPUT, typeByMount);
    expect(selectPrimaryFilesystem(rows)?.mount).toBe("/System/Volumes/Data");
  });

  it("returns an empty list for blank output", () => {
    expect(parseDarwinDfRows("", new Map())).toEqual([]);
  });
});

describe("parseWindowsDiskJson", () => {
  it("handles ConvertTo-Json collapsing a single result to an object", () => {
    const rows = parseWindowsDiskJson(
      '{"drive":"C:","total":1000000000,"free":400000000}',
    );
    expect(rows).toEqual([{ drive: "C:", total: 1000000000, free: 400000000 }]);
  });

  it("parses an array of drives", () => {
    const rows = parseWindowsDiskJson(
      '[{"drive":"C:","total":1000,"free":400},{"drive":"D:","total":2000,"free":1900}]',
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ drive: "D:", total: 2000, free: 1900 });
  });

  it("drops drives with a zero or missing total", () => {
    const rows = parseWindowsDiskJson(
      '[{"drive":"C:","total":0,"free":0},{"drive":"D:","total":100,"free":50}]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].drive).toBe("D:");
  });

  it("returns an empty array for blank or invalid output", () => {
    expect(parseWindowsDiskJson("")).toEqual([]);
    expect(parseWindowsDiskJson("not json")).toEqual([]);
  });
});
