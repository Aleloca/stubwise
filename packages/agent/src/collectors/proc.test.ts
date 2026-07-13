import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseCpu, parseLoadavg, parseMeminfo, parseNetDev } from "./proc.js";

const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../test/fixtures/proc/${name}`, import.meta.url)),
    "utf8",
  );

describe("parseCpu", () => {
  it("computes utilization pct from the delta of the aggregate cpu line", () => {
    // Aggregate `cpu ` lines in the fixtures:
    //   stat1: cpu  1000 0 500 8000 500 0 0 0 0 0
    //          total1 = 1000+0+500+8000+500 = 10000; idle1 = idle+iowait = 8000+500 = 8500
    //          busy1  = total1 - idle1 = 1500
    //   stat2: cpu  1200 0 600 8800 900 0 0 0 0 0
    //          total2 = 1200+0+600+8800+900 = 11500; idle2 = 8800+900 = 9700
    //          busy2  = total2 - idle2 = 1800
    //   totalDelta = 11500 - 10000 = 1500; busyDelta = 1800 - 1500 = 300
    //   pct = busyDelta / totalDelta * 100 = 300 / 1500 * 100 = 20
    expect(parseCpu(fixture("stat1.txt"), fixture("stat2.txt"))).toBeCloseTo(20, 6);
  });

  it("returns 0 for two identical readings (totalDelta 0)", () => {
    const s = fixture("stat1.txt");
    expect(parseCpu(s, s)).toBe(0);
  });
});

describe("parseMeminfo", () => {
  it("computes used/total/swap in bytes with MemAvailable", () => {
    // MemTotal 16000000 kB, MemAvailable 6000000 kB
    //   used = (16000000 - 6000000) kB = 10000000 kB = 10000000 * 1024 = 10240000000 bytes
    //   total = 16000000 * 1024 = 16384000000 bytes
    // SwapTotal 2000000 kB, SwapFree 1500000 kB
    //   swapUsed = 500000 kB = 500000 * 1024 = 512000000 bytes
    expect(parseMeminfo(fixture("meminfo.txt"))).toEqual({
      memUsedBytes: 10240000000,
      memTotalBytes: 16384000000,
      swapUsedBytes: 512000000,
    });
  });

  it("falls back to MemFree when MemAvailable is absent (old kernels)", () => {
    // MemTotal 16000000 kB, MemFree 6000000 kB (no MemAvailable)
    //   used = (16000000 - 6000000) kB = 10240000000 bytes
    expect(parseMeminfo(fixture("meminfo-no-available.txt"))).toEqual({
      memUsedBytes: 10240000000,
      memTotalBytes: 16384000000,
      swapUsedBytes: 512000000,
    });
  });
});

describe("parseLoadavg", () => {
  it("returns the 1-minute load average", () => {
    expect(parseLoadavg(fixture("loadavg.txt"))).toBeCloseTo(0.52, 6);
  });
});

describe("parseNetDev", () => {
  it("sums rx/tx deltas over non-loopback interfaces", () => {
    // eth0:  rx 100000 -> 150000 = +50000 ; tx 50000 -> 70000 = +20000
    // wlan0: rx 200000 -> 180000 = counter went DOWN (reset) => delta 0 ; tx 80000 -> 90000 = +10000
    // lo excluded.
    //   rxBytes = 50000 + 0     = 50000
    //   txBytes = 20000 + 10000 = 30000
    expect(parseNetDev(fixture("netdev1.txt"), fixture("netdev2.txt"))).toEqual({
      rxBytes: 50000,
      txBytes: 30000,
    });
  });

  it("never returns a negative delta when a counter resets", () => {
    // curr fully below prev on every interface => all deltas clamped to 0
    const result = parseNetDev(fixture("netdev2.txt"), fixture("netdev1.txt"));
    // eth0 rx 150000 -> 100000 (down => 0); tx 70000 -> 50000 (down => 0)
    // wlan0 rx 180000 -> 200000 (+20000); tx 90000 -> 80000 (down => 0)
    expect(result.rxBytes).toBe(20000);
    expect(result.txBytes).toBe(0);
    expect(result.rxBytes).toBeGreaterThanOrEqual(0);
    expect(result.txBytes).toBeGreaterThanOrEqual(0);
  });
});
