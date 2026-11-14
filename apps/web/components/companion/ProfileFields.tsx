"use client";

import { useEffect, useMemo, useState } from "react";
import type { LatLng, Skill, Volunteer } from "@clara/contracts";
import { SKILL_LABEL, api, km } from "../../lib/client";
import type { KitMapResponse } from "../../lib/views";
import type { VehicleKind } from "../../lib/rides";
import { LeafletMap, type MapPin } from "../LeafletMap";

/**
 * The volunteer profile as the companion app edits it (onboarding steps and the Profile tab share these fields).
 * Field Kit: square chips, mono labels, ≥44 px targets.
 */

export const AID_SKILLS: Skill[] = ["stop_the_bleed", "cpr", "first_aid", "nurse", "doctor", "emt", "midwife"];
export const LANGUAGES: { code: string; name: string }[] = [
  { code: "en", name: "English" },
  { code: "ar", name: "Arabic" },
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "fa", name: "Persian" },
  { code: "sw", name: "Swahili" },
  { code: "uk", name: "Ukrainian" },
  { code: "zh", name: "Chinese" },
  { code: "hi", name: "Hindi" },
];
export const VEHICLES: { id: Exclude<VehicleKind, "none">; label: string }[] = [
  { id: "car", label: "Car" },
  { id: "van", label: "Van" },
  { id: "motorbike", label: "Motorbike" },
];
export const DEFAULT_RADIUS_KM = 2;

export interface Draft {
  aid: boolean;
  drive: boolean;
  name: string;
  phone: string;
  skills: Skill[];
  vehicle: VehicleKind;
  seats: number;
  lyingDown: boolean;
  wheelchair: boolean;
  languages: string[];
  location: LatLng | null;
  radiusKm: number;
  available: boolean;
  quietOn: boolean;
  quietStart: string;
  quietEnd: string;
  usual: string;
  callConsent: boolean;
}

export const emptyDraft = (): Draft => ({
  aid: false,
  drive: false,
  name: "",
  phone: "",
  skills: [],
  vehicle: "none",
  seats: 0,
  lyingDown: false,
  wheelchair: false,
  languages: ["en"],
  location: null,
  radiusKm: DEFAULT_RADIUS_KM,
  available: true,
  quietOn: false,
  quietStart: "22:00",
  quietEnd: "07:00",
  usual: "",
  callConsent: false,
});

export function draftFromVolunteer(v: Volunteer, vehicle: VehicleKind): Draft {
  const skills = v.skills.filter((s) => s !== "driver");
  return {
    aid: skills.length > 0,
    drive: vehicle !== "none" && v.vehicle_seats > 0,
    name: v.name,
    phone: v.phone ?? "",
    skills,
    vehicle,
    seats: v.vehicle_seats,
    lyingDown: v.carries_lying_down ?? false,
    wheelchair: v.carries_wheelchair ?? false,
    languages: v.languages,
    location: v.location,
    radiusKm: v.alert_radius_km ?? 10,
    available: v.available,
    quietOn: Boolean(v.quiet_hours),
    quietStart: v.quiet_hours?.start ?? "22:00",
    quietEnd: v.quiet_hours?.end ?? "07:00",
    usual: v.usual_availability ?? "",
    callConsent: v.call_consent ?? false,
  };
}

/** "+1 (555) 123-4567" → "+15551234567"; "00…" → "+…". */
export const normalizePhone = (raw: string) => {
  const s = raw.replace(/[\s().-]/g, "");
  return s.startsWith("00") ? `+${s.slice(2)}` : s;
};
export const E164 = /^\+[1-9]\d{6,14}$/;
const tz = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

/**
 * The API body for sign-up ("create": empty fields left out) or a profile edit ("patch": empty optional fields
 * sent as null so they're cleared).
 */
export function draftToBody(d: Draft, mode: "create" | "patch"): Record<string, unknown> {
  const clear = mode === "patch" ? null : undefined;
  const phone = normalizePhone(d.phone);
  const drive = d.drive && d.vehicle !== "none";
  const body: Record<string, unknown> = {
    name: d.name.trim(),
    skills: d.aid ? d.skills : [],
    languages: d.languages.slice(0, 6),
    vehicle: drive ? d.vehicle : "none",
    vehicle_seats: drive ? d.seats : 0,
    location: d.location,
    available: d.available,
    alert_radius_km: d.radiusKm,
    phone: phone || clear,
    call_consent: Boolean(phone) && d.callConsent,
    quiet_hours: d.quietOn ? { start: d.quietStart, end: d.quietEnd, tz: tz() } : clear,
    usual_availability: d.usual.trim() || clear,
    carries_lying_down: drive ? d.lyingDown : clear,
    carries_wheelchair: drive ? d.wheelchair : clear,
  };
  if (mode === "create") body.channel = "app";
  for (const k of Object.keys(body)) if (body[k] === undefined) delete body[k];
  return body;
}

export type Section = "help" | "name" | "skills" | "vehicle" | "where" | "availability";

/** What's missing in one section, in plain words, or null. */
export function problemIn(section: Section, d: Draft): string | null {
  switch (section) {
    case "help":
      return d.aid || d.drive ? null : "Choose at least one way to help.";
    case "name": {
      if (!d.name.trim()) return "Add your name.";
      const p = normalizePhone(d.phone);
      return p && !E164.test(p) ? "Write the phone number with its country code, e.g. +1 555 123 4567." : null;
    }
    case "skills":
      return !d.aid || d.skills.length ? null : "Pick at least one skill, or go back and choose driving only.";
    case "vehicle":
      if (!d.drive) return d.languages.length ? null : "Pick at least one language.";
      if (d.vehicle === "none") return "Pick your vehicle.";
      if (d.seats < 1) return "How many free seats do you have?";
      return d.languages.length ? null : "Pick at least one language.";
    case "where":
      return d.location ? null : "Share your location or tap the map to pick a spot.";
    case "availability":
      return null;
  }
}

const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

type FieldProps = { d: Draft; set(patch: Partial<Draft>): void };

export function HelpFields({ d, set }: FieldProps) {
  const opts: { aid: boolean; drive: boolean; title: string; detail: string }[] = [
    { aid: true, drive: false, title: "Give first aid nearby", detail: "Walk to emergencies close to you with your first-aid skills." },
    { aid: false, drive: true, title: "Drive people to hospital", detail: "I have a car. No medical skills needed: a dispatcher asks you to drive a patient." },
    { aid: true, drive: true, title: "Both", detail: "First aid nearby, and rides to hospital." },
  ];
  return (
    <fieldset className="stack" style={{ gap: 10 }}>
      <legend className="visually-hidden">How can you help?</legend>
      {opts.map((o) => {
        const checked = d.aid === o.aid && d.drive === o.drive;
        return (
          <label key={o.title} className={`choice${checked ? " on" : ""}`}>
            <input
              type="radio"
              name="help-mode"
              checked={checked}
              onChange={() => set({ aid: o.aid, drive: o.drive, ...(o.drive && d.vehicle === "none" ? { vehicle: "car", seats: Math.max(d.seats, 3) } : {}), ...(!o.drive ? { vehicle: "none", seats: 0 } : {}) })}
            />
            <span>
              <b>{o.title}</b>
              <span className="small muted">{o.detail}</span>
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

export function NameFields({ d, set }: FieldProps) {
  const p = normalizePhone(d.phone);
  return (
    <div className="stack" style={{ gap: 14 }}>
      <label className="field">
        <span>Your name</span>
        <input type="text" autoComplete="given-name" maxLength={60} value={d.name} onChange={(e) => set({ name: e.target.value })} />
        <span className="small muted">Shown to the person at the box only after you say you&apos;re coming.</span>
      </label>
      <label className="field">
        <span>Phone number (optional)</span>
        <input type="tel" inputMode="tel" autoComplete="tel" maxLength={22} placeholder="+1 555 123 4567" value={d.phone} onChange={(e) => set({ phone: e.target.value })} />
        <span className={`small ${p && !E164.test(p) ? "t-amber" : "muted"}`}>
          With the country code. Needed only if you want a phone call when an alert goes unseen; you choose that later.
        </span>
      </label>
    </div>
  );
}

export function SkillsFields({ d, set }: FieldProps) {
  return (
    <fieldset className="stack" style={{ gap: 10 }}>
      <legend className="visually-hidden">Your first-aid skills</legend>
      <div className="chips">
        {AID_SKILLS.map((s) => (
          <label key={s} className="chip">
            <input type="checkbox" checked={d.skills.includes(s)} onChange={() => set({ skills: toggle(d.skills, s) })} />
            <span>{SKILL_LABEL[s] ?? s}</span>
          </label>
        ))}
      </div>
      <p className="notice">Self-reported. Skills aren&apos;t verified in this demo; the dispatcher sees them as you wrote them.</p>
    </fieldset>
  );
}

export function VehicleFields({ d, set }: FieldProps) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      {d.drive ? (
        <>
          <fieldset className="stack" style={{ gap: 8 }}>
            <legend>Vehicle</legend>
            <div className="chips" role="radiogroup" aria-label="Vehicle">
              {VEHICLES.map((v) => (
                <label key={v.id} className="chip">
                  <input type="radio" name="vehicle" checked={d.vehicle === v.id} onChange={() => set({ vehicle: v.id, seats: v.id === "motorbike" ? 1 : Math.max(d.seats, v.id === "van" ? 6 : 3) })} />
                  <span>{v.label}</span>
                </label>
              ))}
            </div>
            {d.vehicle === "motorbike" ? <span className="small t-amber">A motorbike can bring a kit or a helper, but usually can&apos;t carry a patient.</span> : null}
          </fieldset>
          <label className="field">
            <span>Free seats</span>
            <input type="number" inputMode="numeric" min={1} max={12} value={d.seats || ""} onChange={(e) => set({ seats: Math.max(0, Math.min(12, Math.floor(Number(e.target.value) || 0))) })} />
          </label>
          <fieldset className="stack" style={{ gap: 8 }}>
            <legend>It can take (optional)</legend>
            <div className="chips">
              <label className="chip">
                <input type="checkbox" checked={d.lyingDown} onChange={(e) => set({ lyingDown: e.target.checked })} />
                <span>Someone lying down</span>
              </label>
              <label className="chip">
                <input type="checkbox" checked={d.wheelchair} onChange={(e) => set({ wheelchair: e.target.checked })} />
                <span>A wheelchair</span>
              </label>
            </div>
          </fieldset>
        </>
      ) : null}
      <fieldset className="stack" style={{ gap: 8 }}>
        <legend>Languages you speak</legend>
        <div className="chips">
          {LANGUAGES.map((l) => (
            <label key={l.code} className="chip">
              <input type="checkbox" checked={d.languages.includes(l.code)} onChange={() => set({ languages: toggle(d.languages, l.code) })} />
              <span>{l.name}</span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

const radiusWords = (r: number) => (r < 1 ? `${Math.round(r * 1000)} m` : `${r % 1 === 0 ? r : r.toFixed(1)} km`);

export function WhereFields({ d, set }: FieldProps) {
  const [site, setSite] = useState<KitMapResponse | null>(null);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    api<KitMapResponse>("/api/kit-map").then(setSite, () => setSite(null));
  }, []);

  function askGps() {
    if (!("geolocation" in navigator)) {
      setNote("This browser can't share a location. Tap the map to pick your spot.");
      return;
    }
    setNote("Asking your phone for its location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set({ location: { lat: pos.coords.latitude, lng: pos.coords.longitude } });
        setNote(`Location from your phone, accurate to about ${Math.round(pos.coords.accuracy)} m.`);
      },
      () => setNote("No location from the browser. Tap the map to pick your spot instead."),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  const nearestBox = useMemo(() => {
    if (!d.location || !site?.pins.length) return null;
    const rad = (x: number) => (x * Math.PI) / 180;
    const dist = (a: LatLng, b: LatLng) => {
      const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
      return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
    };
    return Math.min(...site.pins.map((p) => dist(d.location!, p.location)));
  }, [d.location, site]);

  const pins: MapPin[] = [
    ...(site?.pins ?? []).map((p): MapPin => ({ id: p.box_id, at: p.location, kind: "box", tone: "green", glyph: "+", title: p.name, detail: p.directions })),
    ...(d.location ? [{ id: "you", at: d.location, kind: "you" as const, tone: "green" as const, title: d.drive && !d.aid ? "Home" : "You", detail: "Where you usually are" }] : []),
  ];
  const rings = d.location ? [{ at: d.location, radiusM: d.radiusKm * 1000 }] : [];

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="btn" onClick={askGps}>
          Use my location
        </button>
        <span className="small muted">or tap the map to pick a spot</span>
      </div>
      {site ? (
        <LeafletMap pins={pins} rings={rings} center={d.location ?? site.site.center} zoom={14} label="Map: tap to pick where you usually are" onPick={(at) => {
          set({ location: at });
          setNote("Spot picked on the map.");
        }} />
      ) : (
        <div className="map" />
      )}
      <p className="small" role="status">
        {note ?? (d.location ? "" : "No location yet.")}
      </p>
      <label className="field">
        <span>
          Alert radius · <span className="mono">{radiusWords(d.radiusKm)}</span>
        </span>
        <input type="range" min={0.5} max={10} step={0.5} value={d.radiusKm} aria-valuetext={radiusWords(d.radiusKm)} onChange={(e) => set({ radiusKm: Number(e.target.value) })} />
        <span className="small muted">
          {d.drive && !d.aid ? "Ride requests for pickups within this distance of home." : "Alerts for emergencies within this distance. The closest matching helpers are asked first."}
        </span>
      </label>
      {nearestBox !== null && nearestBox > d.radiusKm ? (
        <p className="notice">
          The nearest demo box is {km(nearestBox)} away, outside your radius, so you won&apos;t get demo alerts. To try the demo, pick a spot on the map near the camp or widen the radius.
        </p>
      ) : null}
    </div>
  );
}

export function AvailabilityFields({ d, set }: FieldProps) {
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <div className="stack" style={{ gap: 2 }}>
          <b>Available now</b>
          <span className="muted small">Switch off any time from Home.</span>
        </div>
        <label className="switch">
          <span className="visually-hidden">Available now</span>
          <input type="checkbox" role="switch" checked={d.available} onChange={(e) => set({ available: e.target.checked })} />
          <span aria-hidden="true" />
        </label>
      </div>
      <label className="field">
        <span>When you&apos;re usually free (optional)</span>
        <input type="text" maxLength={80} placeholder={d.drive ? "Usually home evenings and weekends" : "Weekdays after 5 pm"} value={d.usual} onChange={(e) => set({ usual: e.target.value })} />
        <span className="small muted">A note for the dispatcher. It never stops an alert.</span>
      </label>
      <div className="card">
        <label className="row between" style={{ minHeight: 44 }}>
          <b>Quiet hours</b>
          <input type="checkbox" checked={d.quietOn} onChange={(e) => set({ quietOn: e.target.checked })} style={{ width: 24, height: 24, accentColor: "var(--accent)" }} />
        </label>
        {d.quietOn ? (
          <div className="row" style={{ gap: 12 }}>
            <label className="field grow">
              <span>From</span>
              <input type="time" value={d.quietStart} onChange={(e) => set({ quietStart: e.target.value || "22:00" })} />
            </label>
            <label className="field grow">
              <span>To</span>
              <input type="time" value={d.quietEnd} onChange={(e) => set({ quietEnd: e.target.value || "07:00" })} />
            </label>
          </div>
        ) : null}
        <span className="small muted">During quiet hours Clara won&apos;t buzz your phone or call you. Alerts still wait in the app.</span>
      </div>
    </div>
  );
}
