import { describe, expect, it } from "vitest";
import { GpsTracker, parseGgaQuality, parseRmc } from "../src/location/gps.js";
import { coachingLines } from "../src/session/lines.js";

const nmea = (payload: string) => {
  let checksum = 0;
  for (const char of payload) checksum ^= char.charCodeAt(0);
  return `$${payload}*${checksum.toString(16).toUpperCase().padStart(2, "0")}`;
};

const at = Date.UTC(2026, 10, 14, 5, 36, 45);
const rmc = (status = "A", mode = "A", latitude = "3725.07534") =>
  nmea(`GPRMC,053645.00,${status},${latitude},N,12209.08063,W,0.0,,141126,,,${mode}`);
const gga = (quality: string) => nmea(`GPGGA,053645.00,3725.07534,N,12209.08063,W,${quality},04,1.83,0.0,M,0.0,M,,`);

describe("USB GPS NMEA", () => {
  it("parses the u-blox RMC fields and preserves UTC observation time", () => {
    const result = parseRmc(rmc());
    expect(result?.kind).toBe("fix");
    if (result?.kind !== "fix") throw new Error("fixture is not a fix");
    expect(result.fix.latitude).toBeCloseTo(37.417922, 6);
    expect(result.fix.longitude).toBeCloseTo(-122.151344, 6);
    expect(result.fix.observedAt).toBe(at);
    expect(result.fix.accuracyM).toBeNull();
    expect(parseGgaQuality(gga("1"))).toBe(true);
    expect(parseGgaQuality(gga("0"))).toBe(false);
    expect(parseGgaQuality(gga("6"))).toBe(false);
  });

  it("rejects a bad checksum, invalid status/mode, and malformed coordinates", () => {
    expect(parseRmc(rmc().replace(/.$/, "0"))).toBeNull();
    expect(parseRmc(rmc("V"))).toEqual({ kind: "invalid" });
    expect(parseRmc(rmc("A", "E"))).toEqual({ kind: "invalid" });
    expect(parseRmc(rmc("A", "A", "3799.00000"))).toEqual({ kind: "invalid" });
    expect(parseRmc(nmea("GPRMC,256645.00,A,3725.07534,N,12209.08063,W,0.0,,141126,,,A"))).toEqual({ kind: "invalid" });
  });

  it("accepts only a fresh fix and clears it when the receiver reports no fix", () => {
    let now = at + 1_000;
    const gps = new GpsTracker(() => now);
    gps.push(rmc());
    expect(gps.current()?.latitude).toBeCloseTo(37.417922, 6);
    now += 15_001;
    expect(gps.current()).toBeNull();
    now = at + 1_000;
    gps.push(rmc());
    gps.push(gga("0"));
    expect(gps.current()).toBeNull();
    gps.push(rmc());
    gps.push(rmc("V"));
    expect(gps.current()).toBeNull();
  });

  it("rejects device timestamps outside the freshness window", () => {
    const old = new GpsTracker(() => at + 31_000);
    old.push(rmc());
    expect(old.current()).toBeNull();
    const future = new GpsTracker(() => at - 6_000);
    future.push(rmc());
    expect(future.current()).toBeNull();
  });
});

describe("mock SOS location wording", () => {
  const base = { boxName: "Test Box", directions: null, multipleInjured: false, configuredAddress: "1455 California Ave" };

  it("uses a clearly labeled configured address when GPS is unavailable", () => {
    const line = coachingLines(base)[0]!;
    expect(line).toContain("GPS unavailable. Configured box address: 1455 California Ave.");
    expect(line).not.toContain("coordinates");
  });

  it("uses actual fresh coordinates and their UTC fix time when supplied", () => {
    const result = parseRmc(rmc());
    if (result?.kind !== "fix") throw new Error("fixture is not a fix");
    const line = coachingLines({ ...base, location: result.fix })[0]!;
    expect(line).toContain("GPS coordinates: 37.41792, -122.15134");
    expect(line).toContain("2026-11-14T05:36:45.000Z");
    expect(line).not.toContain("1455 California Ave");
  });
});
