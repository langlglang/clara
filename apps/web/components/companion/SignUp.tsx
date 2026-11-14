"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { LatLng, Volunteer } from "@clara/contracts";
import { ApiError, SKILL_LABEL, api, km, postJson } from "../../lib/client";
import type { KitMapResponse } from "../../lib/views";
import type { VehicleKind } from "../../lib/rides";
import { LeafletMap, type MapPin } from "../LeafletMap";

const SKILLS = (Object.keys(SKILL_LABEL) as Volunteer["skills"]).filter((s) => s !== "driver");
const LANGUAGES: { code: string; name: string }[] = [
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
const VEHICLES: { id: VehicleKind; label: string }[] = [
  { id: "car", label: "Car" },
  { id: "van", label: "Van" },
  { id: "motorbike", label: "Motorbike" },
  { id: "none", label: "No vehicle" },
];
const CHANNELS: { id: Volunteer["channel"]; label: string }[] = [
  { id: "app", label: "This app only" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "imessage", label: "iMessage" },
  { id: "sms", label: "SMS" },
];
/** The network alerts volunteers within this distance of a box. */
const MATCH_RADIUS_KM = 10;

function distanceKm(a: LatLng, b: LatLng) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Volunteer sign-up (feature 8): name, skills, vehicle seats, languages, how to reach them, and a location from
 * the browser's GPS or a spot picked on the demo map. Nothing here is sent until "Join".
 */
export function SignUp({ onJoined, already = false }: { onJoined(v: Volunteer): void; already?: boolean }) {
  const [name, setName] = useState("");
  const [skills, setSkills] = useState<Volunteer["skills"]>([]);
  const [languages, setLanguages] = useState<string[]>(["en"]);
  const [seats, setSeats] = useState(0);
  const [vehicle, setVehicle] = useState<VehicleKind>("none");
  const [channel, setChannel] = useState<Volunteer["channel"]>("app");
  const [phone, setPhone] = useState("");
  const [location, setLocation] = useState<LatLng | null>(null);
  const [locNote, setLocNote] = useState<string | null>(null);
  const [site, setSite] = useState<KitMapResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    api<KitMapResponse>("/api/kit-map").then(setSite, () => setSite(null));
  }, []);

  const toggle = <T extends string>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

  function askGps() {
    if (!("geolocation" in navigator)) {
      setLocNote("This browser can't share a location. Pick your spot on the map instead.");
      return;
    }
    setLocNote("Asking the browser for your location…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setLocNote(`Location from your phone, accurate to about ${Math.round(pos.coords.accuracy)} m.`);
      },
      () => setLocNote("No location from the browser. Pick your spot on the map instead."),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }

  const far = location && site ? distanceKm(location, site.site.center) : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    // A vehicle makes you a driver too (ride requests); the contract needs at least one skill.
    const allSkills: Volunteer["skills"] = vehicle !== "none" ? [...skills, "driver"] : skills;
    const problem = !name.trim() ? "Add your name." : allSkills.length === 0 ? "Pick at least one skill, or a vehicle." : !location ? "Share your location or pick it on the map." : null;
    if (problem) {
      setError(problem);
      requestAnimationFrame(() => errorRef.current?.focus());
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        skills: allSkills,
        languages: languages.slice(0, 6),
        vehicle_seats: vehicle === "none" ? 0 : seats,
        vehicle,
        location: location!,
        channel,
        ...(channel !== "app" && phone.trim() ? { phone: phone.trim().slice(0, 20) } : {}),
      };
      const { volunteer } = await postJson<{ volunteer: Volunteer }>("/api/volunteers", body);
      onJoined(volunteer);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't sign up. Try again.");
      requestAnimationFrame(() => errorRef.current?.focus());
    } finally {
      setBusy(false);
    }
  }

  const pins: MapPin[] = [
    ...(site?.pins ?? []).map((p): MapPin => ({ id: p.box_id, at: p.location, kind: "box", tone: "green", glyph: "+", title: p.name, detail: p.directions })),
    ...(location ? [{ id: "you", at: location, kind: "you" as const, tone: "green" as const, title: "You", detail: "Your sign-up location" }] : []),
  ];

  return (
    <section aria-labelledby="signup-h" className="stack" style={{ gap: 14 }}>
      <h1 id="signup-h" tabIndex={-1}>
        Join your neighborhood&apos;s helpers
      </h1>
      {already ? <p className="notice">This phone is already signed up. Joining again makes a new volunteer and switches this phone to it.</p> : null}
      <p className="muted">You&apos;ll only get alerts you can help with, close to you. You choose each time whether to go.</p>
      <form onSubmit={(e) => void submit(e)} noValidate className="stack" style={{ gap: 14 }}>
        <div className="card">
        <label className="field">
          <span>Your name</span>
          <input type="text" autoComplete="given-name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        </div>

        <fieldset className="card">
          <legend className="visually-hidden">Skills</legend>
          <span className="lbl" aria-hidden="true">Skills</span>
          <div className="chips">
            {SKILLS.map((s) => (
              <label key={s} className="chip">
                <input type="checkbox" checked={skills.includes(s)} onChange={() => setSkills((l) => toggle(l, s))} />
                <span>{SKILL_LABEL[s]}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="card">
          <legend className="visually-hidden">Languages you speak</legend>
          <span className="lbl" aria-hidden="true">Languages</span>
          <div className="chips">
            {LANGUAGES.map((l) => (
              <label key={l.code} className="chip">
                <input type="checkbox" checked={languages.includes(l.code)} onChange={() => setLanguages((x) => toggle(x, l.code))} />
                <span>{l.name}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="card">
          <legend className="visually-hidden">Vehicle</legend>
          <span className="lbl" aria-hidden="true">Vehicle</span>
          <div className="chips" role="radiogroup" aria-label="Vehicle">
            {VEHICLES.map((v) => (
              <label key={v.id} className="chip">
                <input type="radio" name="vehicle" checked={vehicle === v.id} onChange={() => {
                  setVehicle(v.id);
                  if (v.id !== "none" && seats === 0) setSeats(v.id === "motorbike" ? 1 : 4);
                }} />
                <span>{v.label}</span>
              </label>
            ))}
          </div>
          {vehicle !== "none" ? (
            <label className="field">
              <span>Free seats</span>
              <input type="number" inputMode="numeric" min={1} max={12} value={seats} onChange={(e) => setSeats(Math.max(1, Math.min(12, Math.floor(Number(e.target.value) || 1))))} />
            </label>
          ) : null}
          <span className="small muted">Drivers with a car or van can get ride requests to take a patient to hospital. A dispatcher approves every ride.</span>
        </fieldset>

        <div className="card">
          <span className="lbl">Alert radius</span>
          <span>{MATCH_RADIUS_KM} km around you</span>
          <span className="small muted">Set by the network for now; the closest matching helpers are alerted first.</span>
        </div>

        <div className="card">

        <label className="field">
          <span>Also reach me by</span>
          <select value={channel} onChange={(e) => setChannel(e.target.value as Volunteer["channel"])}>
            {CHANNELS.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        {channel !== "app" ? (
          <label className="field">
            <span>Phone number (optional)</span>
            <input type="tel" autoComplete="tel" maxLength={20} value={phone} onChange={(e) => setPhone(e.target.value)} />
            <span className="small muted" style={{ fontWeight: 400 }}>
              Demo: messages over WhatsApp, iMessage and SMS aren&apos;t connected yet. Alerts appear in this app.
            </span>
          </label>
        ) : null}
        </div>

        <fieldset className="card">
          <legend className="visually-hidden">Where you usually are</legend>
          <span className="lbl" aria-hidden="true">Where you usually are</span>
          <div className="row" style={{ marginBottom: 8 }}>
            <button type="button" className="btn small" onClick={askGps}>
              Use my location
            </button>
            <span className="small muted">or tap the map to pick a spot</span>
          </div>
          {site ? (
            <LeafletMap pins={pins} center={site.site.center} zoom={14.5} label="Demo map: tap to pick your spot" onPick={(at) => {
              setLocation(at);
              setLocNote("Spot picked on the map.");
            }} />
          ) : null}
          <p className="small" role="status" style={{ marginTop: 6 }}>
            {locNote ?? (location ? "" : "No location yet.")}
          </p>
          {far !== null && far > MATCH_RADIUS_KM ? (
            <p className="notice">
              That spot is {km(far)} from the demo site. Alerts only go to volunteers within {MATCH_RADIUS_KM} km of a box, so pick a spot on the map to try the demo.
            </p>
          ) : null}
        </fieldset>

        {error ? (
          <p ref={errorRef} tabIndex={-1} className="error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="btn primary block huge" aria-disabled={busy || undefined}>
          {busy ? "Joining…" : "Start helping"}
        </button>
        <p className="small muted" style={{ marginTop: 10 }}>
          Your name, skills and location are shared with the dispatch console of this demo. Proof of concept: nothing here is a real emergency service.
        </p>
      </form>
    </section>
  );
}
