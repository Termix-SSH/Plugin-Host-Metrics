import { describe, expect, it } from "vitest";
import {
  buildRouterOsMetrics,
  parseRouterOsArray,
  parseRouterOsHealth,
  parseRouterOsUptime,
} from "../../../src/backend/routeros.js";

const RESOURCE =
  "architecture-name=arm64;board-name=hAP ax^3;build-time=2024-03-27 13:51:33;cpu=ARM64;cpu-count=4;cpu-frequency=864;cpu-load=7;free-hdd-space=102973440;free-memory=805306368;platform=MikroTik;total-hdd-space=134217728;total-memory=1073741824;uptime=1w2d03:04:05;version=7.14.2 (stable);write-sect-since-reboot=5021;write-sect-total=45233\n";

const HEALTH =
  "cpu-temperature;48;C\nboard-temperature1;40;C\nfan1-speed;3000;RPM\n";

const INTERFACES =
  "ether1;1000;2000;true;false\nwifi1;500;600;true;false\nether5;0;0;false;true\n";

const ADDRESSES = "ether1;192.168.88.1/24\nbridge;10.0.0.1/24\n";

describe("RouterOS parsing", () => {
  it("reads a :put array", () => {
    const res = parseRouterOsArray(RESOURCE);
    expect(res["board-name"]).toBe("hAP ax^3");
    expect(res.version).toBe("7.14.2 (stable)");
    expect(res["cpu-load"]).toBe("7");
  });

  it("reads uptime in both formats", () => {
    expect(parseRouterOsUptime("1w2d03:04:05")).toBe(
      604800 + 2 * 86400 + 3 * 3600 + 4 * 60 + 5,
    );
    expect(parseRouterOsUptime("00:10:00")).toBe(600);
    expect(parseRouterOsUptime("3d4h5m6s")).toBe(
      3 * 86400 + 4 * 3600 + 5 * 60 + 6,
    );
    expect(parseRouterOsUptime("")).toBeNull();
  });

  it("reads health sensors", () => {
    expect(parseRouterOsHealth(HEALTH)).toHaveLength(3);
  });

  it("fills the cards from one sample, and rates from the next", () => {
    const first = buildRouterOsMetrics(
      {
        resource: RESOURCE,
        identity: "home-router\n",
        health: HEALTH,
        interfaces: INTERFACES,
        addresses: ADDRESSES,
      },
      undefined,
      1000,
    );
    const m = first.metrics;
    expect(m.cpu).toMatchObject({ percent: 7, cores: 4 });
    expect(m.memory).toMatchObject({ percent: 25, totalGiB: 1 });
    expect(m.disk.percent).toBe(23);
    expect(m.uptime.seconds).toBe(604800 + 2 * 86400 + 11045);
    expect(m.system).toEqual({
      hostname: "home-router",
      kernel: "RouterOS 7.14.2 (stable)",
      os: "MikroTik hAP ax^3",
    });
    expect(m.temperature.highestCelsius).toBe(48);
    expect(m.temperature.sensors).toHaveLength(2);
    expect(m.network.interfaces.map((i) => i.name)).toEqual([
      "ether1",
      "wifi1",
    ]);
    expect(m.network.interfaces[0]).toMatchObject({
      ip: "192.168.88.1",
      state: "UP",
      rxRateBps: null,
    });

    const second = buildRouterOsMetrics(
      {
        resource: RESOURCE,
        identity: "home-router",
        health: HEALTH,
        interfaces: "ether1;3000;2500;true;false\n",
        addresses: ADDRESSES,
      },
      { counters: first.counters, timestamp: 1000 },
      3000,
    );
    expect(second.metrics.network.interfaces[0]).toMatchObject({
      rxRateBps: 1000,
      txRateBps: 250,
    });
  });
});
