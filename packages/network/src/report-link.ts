import { createHash } from "node:crypto";
import { BoxPushSchema, type BoxPush, type Incident } from "@clara/contracts";
import type { IncidentEntry, Store } from "./store.js";

/** Where the EMS links point when PUBLIC_BASE_URL is not set. */
export const DEFAULT_PUBLIC_BASE_URL = "https://clara.living";

/** No 0/O or 1/I, so a paramedic can type the code from the box screen. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The short code for a report token: six characters derived from a hash of the token (not guessable from the incident). */
export function reportShortCode(token: string): string {
  const digest = createHash("sha256").update(token).digest();
  let code = "";
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[digest[i]! % CODE_ALPHABET.length];
  return code;
}

export const normalizeBaseUrl = (base: string | undefined | null) => (base?.trim() || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, "");

/** The full report link and the short one for an incident. */
export function reportLinks(incident: Incident, baseUrl: string) {
  const base = normalizeBaseUrl(baseUrl);
  const code = reportShortCode(incident.report_token);
  return { report_url: `${base}/report/${encodeURIComponent(incident.report_token)}`, short_url: `${base}/r/${code}`, report_code: code };
}

/** The `incident.opened` push for the incident's own box. */
export function incidentOpenedPush(incident: Incident, baseUrl: string): BoxPush {
  const { report_url, report_code } = reportLinks(incident, baseUrl);
  return BoxPushSchema.parse({ type: "incident.opened", incident_id: incident.incident_id, report_url, report_code });
}

/** The incident behind a short code, only when exactly one incident has it (a collision resolves to nothing). */
export function incidentByShortCode(store: Store, code: string): IncidentEntry | undefined {
  const wanted = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(wanted)) return undefined;
  const found = store.listIncidents().filter((e) => reportShortCode(e.incident.report_token) === wanted);
  return found.length === 1 ? found[0] : undefined;
}
