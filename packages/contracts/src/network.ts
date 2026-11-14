import { z } from "zod";
import { Id } from "./scenario.js";
import { EmergencyQuestionIdSchema } from "./events.js";
import { SpeechSchema } from "./voice.js";

/**
 * The response network: volunteers, incidents and alerts. The alert lifecycle follows Sophi's help
 * request (sent → shown → coming → closed; github.com/mzhao1599/sophi, docs/subsystems/help.md),
 * adapted from one caretaker circle to nearby volunteers.
 */

export const SkillSchema = z.enum(["stop_the_bleed", "cpr", "first_aid", "nurse", "doctor", "emt", "midwife", "driver"]);
export type Skill = z.infer<typeof SkillSchema>;

export const LatLngSchema = z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });
export type LatLng = z.infer<typeof LatLngSchema>;

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM");
/** Quiet hours, e.g. 22:00 to 07:00 in the volunteer's own time zone (IANA name). */
export const QuietHoursSchema = z.strictObject({ start: HHMM, end: HHMM, tz: z.string().min(1).max(64) });
export type QuietHours = z.infer<typeof QuietHoursSchema>;

export const VolunteerSchema = z.strictObject({
  volunteer_id: Id,
  name: z.string().trim().min(1).max(60),
  skills: z.array(SkillSchema).min(1).max(8),
  languages: z.array(z.string().min(2).max(8)).max(6),
  /** Seats free when they have a vehicle; 0 without one. */
  vehicle_seats: z.number().int().min(0).max(12),
  location: LatLngSchema,
  available: z.boolean(),
  /** How to reach them besides the app. */
  channel: z.enum(["app", "whatsapp", "imessage", "sms"]),
  phone: z.string().max(20).optional(),
  /** Alert me only for emergencies within this distance (km). Absent: the network's default radius. */
  alert_radius_km: z.number().min(0.5).max(10).optional(),
  /** They agreed to a phone call when an app alert goes unseen. Absent means no. */
  call_consent: z.boolean().optional(),
  /** Hours when Clara doesn't buzz or call them (alerts still show in the app). Times are HH:MM in `tz`. */
  quiet_hours: QuietHoursSchema.optional(),
  /** Drivers: the vehicle can take someone lying down (seats folded, van floor). Self-reported. */
  carries_lying_down: z.boolean().optional(),
  /** Drivers: the vehicle can take a wheelchair. Self-reported. */
  carries_wheelchair: z.boolean().optional(),
  /** Free text such as "usually home evenings"; shown to dispatch, never used to promise anything. */
  usual_availability: z.string().trim().max(80).optional(),
});
export type Volunteer = z.infer<typeof VolunteerSchema>;

export const BoxStatusSchema = z.enum(["ready", "in_use", "low_supplies", "offline"]);
export type BoxStatus = z.infer<typeof BoxStatusSchema>;

export const BoxRecordSchema = z.strictObject({
  box_id: Id,
  name: z.string().min(1).max(80),
  location: LatLngSchema,
  /** Written directions, used indoors where GPS is weak. */
  directions: z.string().max(200),
  status: BoxStatusSchema,
  last_seen_at: z.iso.datetime().nullable(),
  battery_pct: z.number().min(0).max(100).nullable(),
});
export type BoxRecord = z.infer<typeof BoxRecordSchema>;

/** One alert to one volunteer. `coming` and `arrived` come only from that volunteer's own action. */
export const AlertStateSchema = z.enum(["sent", "shown", "coming", "declined", "arrived", "expired", "cancelled"]);
export type AlertState = z.infer<typeof AlertStateSchema>;

export const AlertSchema = z.strictObject({
  alert_id: Id,
  incident_id: Id,
  volunteer_id: Id,
  volunteer_name: z.string().max(60),
  state: AlertStateSchema,
  /** Walking or driving minutes estimated when they accepted; null before. */
  eta_minutes: z.number().int().min(0).max(600).nullable(),
  sent_at: z.iso.datetime(),
  updated_at: z.iso.datetime(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const IncidentSchema = z.strictObject({
  incident_id: Id,
  box_id: Id,
  session_id: z.uuid(),
  need: z.enum(["bleeding", "breathing", "general"]),
  opened_at: z.iso.datetime(),
  closed: z.strictObject({ how: z.enum(["arrived", "cancelled", "expired"]), at: z.iso.datetime() }).nullable(),
  alerts: z.array(AlertSchema),
  /** Secret token for the EMS scene report link. */
  report_token: z.string().min(16).max(64),
});
export type Incident = z.infer<typeof IncidentSchema>;

/** Volunteer answers from the companion app (or a WhatsApp / iMessage reply mapped to one). */
export const AlertResponseSchema = z.strictObject({
  action: z.enum(["shown", "coming", "declined", "arrived"]),
  /** Where the volunteer's phone is when they answer (optional; the ETA uses it instead of their saved location). */
  from: z.strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).optional(),
});
export type AlertResponse = z.infer<typeof AlertResponseSchema>;

/** Short code for the EMS report link (`<base>/r/AB12CD`): six upper-case letters and digits. */
export const ReportCodeSchema = z.string().regex(/^[A-Z0-9]{6}$/);

/** Messages the server pushes to a box over its live stream. */
export const BoxPushSchema = z.discriminatedUnion("type", [
  /**
   * The box's own incident opened (replayed when the box stream reconnects while it is open). `report_url` is the
   * absolute EMS scene report link; `report_code` is the short code behind `<base>/r/<code>`.
   */
  z.strictObject({ type: z.literal("incident.opened"), incident_id: Id, report_url: z.url().max(300), report_code: ReportCodeSchema }),
  z.strictObject({ type: z.literal("alert.update"), incident_id: Id, alert: AlertSchema }),
  z.strictObject({ type: z.literal("responder.message"), incident_id: Id, from: z.string().max(60), text: z.string().max(300) }),
  z.strictObject({ type: z.literal("nearby.emergency"), incident_id: Id, from_box_id: Id, from_box_name: z.string().max(80), directions: z.string().max(200) }),
  z.strictObject({ type: z.literal("nearby.clear"), incident_id: Id }),
  z.strictObject({ type: z.literal("emergency.question"), incident_id: Id, task_id: z.uuid(), session_id: z.uuid(), question_id: EmergencyQuestionIdSchema, prompt: z.string().min(1).max(200), speech: SpeechSchema.optional() }),
  z.strictObject({ type: z.literal("emergency.status"), incident_id: Id, task_id: z.uuid(), session_id: z.uuid(), state: z.enum(["collecting_facts", "facts_ready", "cancelled"]) }),
  z.strictObject({ type: z.literal("dispatcher.call_status"), incident_id: Id, session_id: z.uuid(), state: z.enum(["placed", "failed", "not_configured"]) }),
]);
export type BoxPush = z.infer<typeof BoxPushSchema>;

/**
 * The only sentence the box may say about who is coming. Template, not model words: names and times come
 * from accepted alerts only. Returns null when nobody has accepted, so callers cannot promise help early.
 */
export function comingLine(alerts: readonly Alert[]): string | null {
  const coming = alerts.filter((a) => a.state === "coming" || a.state === "arrived");
  if (coming.length === 0) return null;
  const first = coming[0]!;
  if (first.state === "arrived") return `${first.volunteer_name} is here.`;
  const eta = first.eta_minutes === null ? "" : `, about ${Math.max(1, first.eta_minutes)} minute${first.eta_minutes === 1 ? "" : "s"}`;
  const others = coming.length > 1 ? ` ${coming.length - 1} more ${coming.length === 2 ? "person is" : "people are"} coming too.` : "";
  return `${first.volunteer_name} is coming${eta}.${others}`;
}
