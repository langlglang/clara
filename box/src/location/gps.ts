/** A local GNSS observation. `accuracyM` is null: NMEA HDOP is not a metre accuracy estimate. */
export interface GpsFix {
  latitude: number;
  longitude: number;
  /** UTC time from the receiver's RMC sentence, in epoch milliseconds. */
  observedAt: number;
  accuracyM: number | null;
}

export interface LocationProvider {
  /** Only a currently valid fix; null after invalid status, disconnect, or staleness. */
  current(): GpsFix | null;
  close(): Promise<void>;
}

/** A checksummed RMC sentence is either a fix, explicitly invalid, or irrelevant/malformed. */
export type RmcResult = { kind: "fix"; fix: GpsFix } | { kind: "invalid" } | null;

export const GPS_MAX_RECEIVE_AGE_MS = 15_000;
export const GPS_MAX_FIX_AGE_MS = 30_000;
export const GPS_MAX_FUTURE_MS = 5_000;

function fields(line: string): string[] | null {
  const trimmed = line.trim();
  const match = /^\$([^*\r\n]+)\*([0-9A-Fa-f]{2})$/.exec(trimmed);
  if (!match || trimmed.length > 160) return null;
  let checksum = 0;
  for (const char of match[1]!) checksum ^= char.charCodeAt(0);
  if (checksum !== Number.parseInt(match[2]!, 16)) return null;
  return match[1]!.split(",");
}

function coordinate(raw: string, hemisphere: string, degreeDigits: 2 | 3): number | null {
  const pattern = degreeDigits === 2 ? /^\d{4}(?:\.\d+)?$/ : /^\d{5}(?:\.\d+)?$/;
  if (!pattern.test(raw)) return null;
  const degrees = Number(raw.slice(0, degreeDigits));
  const minutes = Number(raw.slice(degreeDigits));
  if (!Number.isFinite(minutes) || minutes >= 60) return null;
  const limit = degreeDigits === 2 ? 90 : 180;
  if (degrees > limit || (degrees === limit && minutes !== 0)) return null;
  if (degreeDigits === 2 && hemisphere !== "N" && hemisphere !== "S") return null;
  if (degreeDigits === 3 && hemisphere !== "E" && hemisphere !== "W") return null;
  const value = degrees + minutes / 60;
  return hemisphere === "S" || hemisphere === "W" ? -value : value;
}

function utc(date: string, time: string): number | null {
  const d = /^(\d{2})(\d{2})(\d{2})$/.exec(date);
  const t = /^(\d{2})(\d{2})(\d{2})(?:\.(\d+))?$/.exec(time);
  if (!d || !t) return null;
  const day = Number(d[1]);
  const month = Number(d[2]);
  const year = 2000 + Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = Number(t[3]);
  const millis = Number((t[4] ?? "").slice(0, 3).padEnd(3, "0"));
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const value = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const checked = new Date(value);
  return checked.getUTCFullYear() === year && checked.getUTCMonth() === month - 1 && checked.getUTCDate() === day ? value : null;
}

/** Parses GPS/GNSS RMC from a real NMEA receiver. It requires checksum, valid status and GNSS mode. */
export function parseRmc(line: string): RmcResult {
  const f = fields(line);
  if (!f || !/^[A-Z]{2}RMC$/.test(f[0] ?? "")) return null;
  if (f[2] !== "A" || (f[12] && !["A", "D"].includes(f[12]))) return { kind: "invalid" };
  const latitude = coordinate(f[3] ?? "", f[4] ?? "", 2);
  const longitude = coordinate(f[5] ?? "", f[6] ?? "", 3);
  const observedAt = utc(f[9] ?? "", f[1] ?? "");
  if (latitude === null || longitude === null || observedAt === null) return { kind: "invalid" };
  return { kind: "fix", fix: { latitude, longitude, observedAt, accuracyM: null } };
}

/** Returns true for a good GGA fix, false for no/estimated fix, null for unrelated/malformed input. */
export function parseGgaQuality(line: string): boolean | null {
  const f = fields(line);
  if (!f || !/^[A-Z]{2}GGA$/.test(f[0] ?? "")) return null;
  return f[6] === "1" || f[6] === "2";
}

export class GpsTracker {
  private fix: GpsFix | null = null;
  private receivedAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  push(line: string): void {
    const rmc = parseRmc(line);
    if (rmc?.kind === "invalid" || parseGgaQuality(line) === false) {
      this.invalidate();
      return;
    }
    if (rmc?.kind !== "fix") return;
    const now = this.now();
    if (rmc.fix.observedAt < now - GPS_MAX_FIX_AGE_MS || rmc.fix.observedAt > now + GPS_MAX_FUTURE_MS) {
      this.invalidate();
      return;
    }
    this.fix = rmc.fix;
    this.receivedAt = now;
  }

  current(): GpsFix | null {
    const now = this.now();
    if (!this.fix || now < this.receivedAt || now - this.receivedAt > GPS_MAX_RECEIVE_AGE_MS) return null;
    if (this.fix.observedAt < now - GPS_MAX_FIX_AGE_MS || this.fix.observedAt > now + GPS_MAX_FUTURE_MS) return null;
    return { ...this.fix };
  }

  invalidate(): void {
    this.fix = null;
    this.receivedAt = 0;
  }
}
