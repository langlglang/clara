// Adapted from Sophi (github.com/mzhao1599/sophi), apps/web/src/components/HelpScreens.tsx (MayaHelpCard).
// Same shape: the alert leads the app while it is open; one busy action at a time; a failure line belongs to the
// state it happened in; a late answer to a closed request shows as closed; focus moves to the heading when the
// control that had it goes away. Sophi's "I'm on my way / I'm with her" becomes the Field Kit phone screens:
// Incoming alert (I'm coming / Can't help right now), On the way (ETA, what the box said, live scene, message the
// box, I've arrived) and the driver's ride offer (accept within the timer).
"use client";

import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Alert } from "@clara/contracts";
import { ApiError, NEED_LABEL, SKILL_LABEL, agoWords, clockShort, directionsUrl, km, postJson } from "../../lib/client";
import type { InboxItem, RideOfferItem } from "../../lib/views";
import { LeafletMap, type MapPin } from "../LeafletMap";
import { Tile } from "../TopBar";

const failureLine = (e: unknown) =>
  e instanceof ApiError
    ? e.status === 409
      ? e.message
      : e.status === 0
        ? "Couldn't reach the server. Check your connection and tap again."
        : e.message
    : "Something went wrong. Tap again.";

/** Keeps focus from being lost when the control that had it goes away: it moves to the heading. */
export function useKeepFocus(view: string, box: React.RefObject<HTMLElement | null>, heading: React.RefObject<HTMLElement | null>) {
  const last = useRef(view);
  const had = useRef(false);
  had.current = typeof document !== "undefined" && !!box.current && box.current.contains(document.activeElement);
  useLayoutEffect(() => {
    if (last.current === view) return;
    last.current = view;
    if (had.current && (document.activeElement === document.body || document.activeElement === null)) heading.current?.focus();
  }, [view, heading]);
}

/** One busy action at a time, with a failure line tied to the view it happened in. */
function useAct(view: string, refresh: () => Promise<void>, announce: (t: string) => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ line: string; view: string } | null>(null);
  async function act<T>(kind: string, call: () => Promise<T>, done?: (r: T) => string | null) {
    if (busy) return;
    setBusy(kind);
    setFailed(null);
    try {
      const r = await call();
      const said = done?.(r);
      if (said) announce(said);
    } catch (e) {
      const line = failureLine(e);
      setFailed({ line, view });
      announce(line);
    } finally {
      await refresh();
      setBusy(null);
    }
  }
  return { busy, error: failed?.view === view ? failed.line : null, act };
}

const ambulanceWords = (min: number | null) => (min === null ? "Not known" : `${min}+ min`);

/** Incoming alert, or On the way once they said they're coming. */
export function AlertScreen({ item, volunteerId, refresh, announce, now }: { item: InboxItem; volunteerId: string; refresh(): Promise<void>; announce(t: string): void; now: number }) {
  const [answer, setAnswer] = useState<Alert | null>(null);
  const box = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = answer && answer.alert_id === item.alert.alert_id && Date.parse(answer.updated_at) >= Date.parse(item.alert.updated_at) ? answer : item.alert;
  const view = `${alert.alert_id}/${alert.state}`;
  useKeepFocus(view, box, heading);
  const { busy, error, act } = useAct(view, refresh, announce);
  const boxName = item.box?.name ?? item.incident.box_id;
  const respond = (action: "coming" | "declined" | "arrived") =>
    act(
      action,
      async () => {
        // "I'm coming": send where the phone is now so the walking time is real, not from the saved profile spot.
        const from = action === "coming" ? await herePosition() : null;
        return postJson<{ alert: Alert }>(`/api/alerts/${encodeURIComponent(alert.alert_id)}/respond`, { volunteer_id: volunteerId, action, ...(from ? { from } : {}) });
      },
      (r) => {
        setAnswer(r.alert);
        return action === "coming" ? `You said you're coming to ${boxName}.` : action === "arrived" ? "Marked as arrived." : "You said you can't help this time.";
      },
    );

  if (alert.state === "coming" || alert.state === "arrived")
    return <OnTheWay item={item} alert={alert} volunteerId={volunteerId} boxRef={box} headingRef={heading} busy={busy} error={error} respond={respond} refresh={refresh} announce={announce} />;

  const s = item.scene;
  const need = NEED_LABEL[item.incident.need] ?? item.incident.need;
  return (
    <section ref={box} className="stack" aria-labelledby={`alert-h-${alert.alert_id}`}>
      <span className="lbl t-red">Emergency nearby · {agoWords(item.incident.opened_at, now)}</span>
      <h1 id={`alert-h-${alert.alert_id}`} ref={heading} tabIndex={-1} style={{ fontSize: "2rem" }}>
        {need}
      </h1>
      <span className="muted">
        {boxName}
        {item.distance_km !== null ? ` · ${km(item.distance_km)}` : ""}
        {item.eta ? ` · ${Math.max(1, item.eta.minutes)} min ${item.eta.mode === "driving" ? "drive" : "walk"}` : ""}
      </span>
      <div className="tiles">
        <Tile label="TQ timer started" value={s.tourniquet_at ? clockShort(s.tourniquet_at) : "—"} tone={s.tourniquet_at ? "red" : undefined} />
        <Tile label="Pulse (sensor)" value={s.pulse?.bpm ?? "—"} tone={s.pulse?.bpm ? "red" : undefined} />
        <Tile label="Also alerted" value={Math.max(0, s.alerted - 1)} />
        <Tile label="Ambulance" value={ambulanceWords(s.ambulance_eta_min)} />
      </div>
      <div className="card" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span>Needs {item.needs_skills.slice(0, 3).map((x) => SKILL_LABEL[x] ?? x).join(" or ")}</span>
        {item.you_match ? <b className="t-green mono">YOU MATCH</b> : <b className="muted mono">NO MATCH</b>}
      </div>
      <Handoff item={item} />
      {alert.state === "declined" ? <p className="muted">You said you can&apos;t help. Others are being alerted. You can still go if things change.</p> : null}
      <button type="button" className="btn primary block huge" aria-disabled={busy !== null || undefined} onClick={() => void respond("coming")}>
        {busy === "coming" ? "Sending…" : "I'm coming"}
      </button>
      {alert.state !== "declined" ? (
        <button type="button" className="btn block" aria-disabled={busy !== null || undefined} onClick={() => void respond("declined")}>
          {busy === "declined" ? "Sending…" : "Can't help right now"}
        </button>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}

function Handoff({ item }: { item: InboxItem }) {
  return (
    <div className="card">
      <span className="lbl">What happened so far</span>
      {item.handoff.length ? (
        <ul className="list small">
          {item.handoff.map((l, i) => (
            <li key={i}>
              <span className="label-tag" data-label={l.label}>
                {l.label}
              </span>
              {l.text}
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">The box sent an SOS. No other details yet.</p>
      )}
    </div>
  );
}

function OnTheWay({
  item,
  alert,
  volunteerId,
  boxRef,
  headingRef,
  busy,
  error,
  respond,
  refresh,
  announce,
}: {
  item: InboxItem;
  alert: Alert;
  volunteerId: string;
  boxRef: React.RefObject<HTMLElement | null>;
  headingRef: React.RefObject<HTMLHeadingElement | null>;
  busy: string | null;
  error: string | null;
  respond(a: "coming" | "declined" | "arrived"): Promise<void>;
  refresh(): Promise<void>;
  announce(t: string): void;
}) {
  const [text, setText] = useState("");
  const msg = useAct(`msg/${alert.alert_id}`, refresh, announce);
  const arrived = alert.state === "arrived";
  const send = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    void msg.act(
      "send",
      () => postJson(`/api/incidents/${encodeURIComponent(item.incident.incident_id)}/messages`, { volunteer_id: volunteerId, text: t }),
      () => {
        setText("");
        return "Sent. The box reads it aloud.";
      },
    );
  };
  return (
    <section ref={boxRef} className="stack" aria-labelledby={`otw-h-${alert.alert_id}`}>
      <span className={`lbl ${arrived ? "t-green" : "t-blue"}`}>{arrived ? "You're at the scene" : "You're on the way"}</span>
      <h1 id={`otw-h-${alert.alert_id}`} ref={headingRef} tabIndex={-1} className="huge-num">
        {arrived ? "Arrived" : alert.eta_minutes !== null ? `${Math.max(1, alert.eta_minutes)} min` : "On the way"}
      </h1>
      {item.coming_line ? (
        <p className="muted">
          The box told the bystander: &ldquo;{item.coming_line}&rdquo;
        </p>
      ) : null}
      {item.box ? (
        <div className="card">
          <span className="lbl">Directions · {item.box.name}</span>
          <span>{item.box.directions}</span>
          <a className="btn small" href={directionsUrl(item.box.location.lat, item.box.location.lng)} target="_blank" rel="noreferrer">
            Open in maps
          </a>
        </div>
      ) : null}
      <div className="card">
        <span className="lbl">Live at the scene</span>
        {item.timeline.length ? (
          <div className="stack" style={{ gap: 6 }}>
            {item.timeline.map((l, i) => (
              <div key={i} className="tl">
                <span className="when">{clockShort(l.at)}</span>
                <span>
                  {l.text.replace(/^\d{1,2}:\d{2}\s?[AP]M\s/, "")}{" "}
                  <span className="label-tag" data-label={l.label}>
                    {l.label}
                  </span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="small muted">Nothing from the box yet.</p>
        )}
        {item.messages.length ? (
          <div className="stack small" style={{ gap: 4, marginTop: 6 }}>
            <span className="lbl">Messages to the box</span>
            {item.messages.map((m, i) => (
              <span key={i}>
                <b>{m.from}:</b> {m.text} <span className="muted mono">{clockShort(m.at)}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <form onSubmit={send} className="stack" style={{ gap: 6 }}>
        <label className="field">
          <span>Message the box (read aloud)</span>
          <input type="text" maxLength={200} value={text} onChange={(e) => setText(e.target.value)} placeholder="Keep pressure, I'm close" />
        </label>
        <button type="submit" className="btn block" aria-disabled={msg.busy !== null || !text.trim() || undefined}>
          {msg.busy ? "Sending…" : "Send to the box"}
        </button>
        {msg.error ? <p className="error" role="alert">{msg.error}</p> : null}
      </form>
      {arrived ? (
        <p>Follow the box&apos;s screen and hand over to EMS when they reach you. The scene report is on the box&apos;s screen and in dispatch.</p>
      ) : (
        <>
          <button type="button" className="btn go block huge" aria-disabled={busy !== null || undefined} onClick={() => void respond("arrived")}>
            {busy === "arrived" ? "Sending…" : "I've arrived"}
          </button>
          <button type="button" className="btn small block" aria-disabled={busy !== null || undefined} onClick={() => void respond("declined")}>
            {busy === "declined" ? "Sending…" : "I can't come after all"}
          </button>
        </>
      )}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}

const TRIP_LINE: Record<string, string> = {
  to_pickup: "On the way to pickup.",
  patient_in_car: "Patient in the car. Drive to the hospital.",
  at_hospital: "Arrived at hospital. Thank you for driving.",
};

/** Driver ride offer: pickup / hospital / ambulance times, accept within the timer; one accept wins. */
export function RideScreen({ item, volunteerId, refresh, announce, now }: { item: RideOfferItem; volunteerId: string; refresh(): Promise<void>; announce(t: string): void; now: number }) {
  const { ride, box, my_offer } = item;
  const box_ = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const won = ride.winner?.driver_id === volunteerId;
  const view = `${ride.ride_id}/${won ? "won" : my_offer?.state ?? "none"}`;
  useKeepFocus(view, box_, heading);
  const { busy, error, act } = useAct(view, refresh, announce);
  const answer = (action: "accept" | "decline") =>
    act(action, () => postJson(`/api/rides/${encodeURIComponent(ride.ride_id)}/answer`, { driver_id: volunteerId, action }), () => (action === "accept" ? "Ride accepted. You're driving." : "Ride declined."));
  const left = my_offer ? Math.max(0, Math.ceil((Date.parse(my_offer.expires_at) - now) / 1000)) : 0;
  const open = my_offer?.state === "offered" && !ride.winner && left > 0;

  const pins: MapPin[] = [];
  if (box) pins.push({ id: "box", at: box.location, kind: "emergency", tone: "red", title: `Pickup: ${box.name}`, detail: box.directions, pulse: true });
  pins.push({ id: "hospital", at: ride.hospital.location, kind: "hospital", tone: "white", glyph: "H", title: ride.hospital.name, detail: "Hospital" });
  const lines = box ? [{ points: [box.location, ride.hospital.location], color: "#38BDF8" }] : [];

  return (
    <section ref={box_} className="stack" aria-labelledby={`ride-h-${ride.ride_id}`}>
      {box ? <LeafletMap pins={pins} lines={lines} center={box.location} zoom={12.5} label={`Map: pickup at ${box.name}, drop-off at ${ride.hospital.name}`} /> : null}
      <div className="sheet">
        <span className={`lbl ${won ? "t-green" : open ? "t-red" : ""}`}>
          {won ? "Your ride" : open ? `Ride request · expires ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "Ride request"}
        </span>
        <h1 id={`ride-h-${ride.ride_id}`} ref={heading} tabIndex={-1} style={{ fontSize: "1.4rem" }}>
          {won ? `Drive to ${box?.name ?? "the box"}, then ${ride.hospital.name}` : "Take a patient to hospital"}
        </h1>
        <div className="tiles three">
          <Tile label="Pickup" value={item.pickup_minutes !== null ? `${Math.max(1, item.pickup_minutes)} min` : "—"} />
          <Tile label="Hospital" value={ride.hospital_minutes !== null ? `${ride.hospital_minutes} min` : "—"} />
          <Tile label="Ambulance" value={item.ambulance_eta_min === null ? "?" : `${item.ambulance_eta_min}+`} tone="red" />
        </div>
        <span className="small">
          <b>{box?.name ?? "The box"}</b> → <b>{ride.hospital.name}</b>
          {ride.hospital_km !== null ? ` · ${ride.hospital_km.toFixed(1)} km, about ${ride.hospital_minutes} min` : ""} · {ride.seats_needed} seat{ride.seats_needed === 1 ? "" : "s"}
        </span>
        <span className="muted small">
          {[ride.note, box ? `Pickup: ${box.directions}` : null, "Dispatcher approved"].filter(Boolean).join(" · ")}
        </span>
        {won ? (
          <>
            <p>
              <b>{TRIP_LINE[ride.trip?.step ?? "to_pickup"]}</b>
              {ride.trip?.step === "to_pickup" || !ride.trip ? " The box was told your name and pickup time." : ""}
            </p>
            {ride.trip?.step === "at_hospital" ? null : (
              <button
                type="button"
                className="btn primary block huge"
                aria-disabled={busy !== null || undefined}
                onClick={() => {
                  const step = ride.trip?.step === "patient_in_car" ? "at_hospital" : "patient_in_car";
                  void act(step, () => postJson(`/api/rides/${encodeURIComponent(ride.ride_id)}/progress`, { driver_id: volunteerId, step }), () => (step === "at_hospital" ? "Marked: arrived at hospital." : "Marked: patient in the car."));
                }}
              >
                {busy ? "Sending…" : ride.trip?.step === "patient_in_car" ? "Arrived at hospital" : "Patient in car"}
              </button>
            )}
            {box && ride.trip?.step !== "patient_in_car" && ride.trip?.step !== "at_hospital" ? (
              <a className="btn block" href={directionsUrl(box.location.lat, box.location.lng)} target="_blank" rel="noreferrer">
                Directions to pickup
              </a>
            ) : null}
            {ride.trip?.step !== "at_hospital" ? (
              <a className="btn block" href={directionsUrl(ride.hospital.location.lat, ride.hospital.location.lng)} target="_blank" rel="noreferrer">
                Directions to hospital
              </a>
            ) : null}
          </>
        ) : open ? (
          <>
            <button type="button" className="btn primary block huge" aria-disabled={busy !== null || undefined} onClick={() => void answer("accept")}>
              {busy === "accept" ? "Sending…" : "Accept ride"}
            </button>
            <button type="button" className="btn block" aria-disabled={busy !== null || undefined} onClick={() => void answer("decline")}>
              {busy === "decline" ? "Sending…" : "Decline"}
            </button>
          </>
        ) : (
          <p className="muted">
            {ride.winner ? "Another driver took this ride. Thank you." : my_offer?.state === "declined" ? "You declined this ride." : "This offer has ended."}
          </p>
        )}
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

/**
 * The phone's position right now, or null: no permission, no fix within a few seconds, or a fix too rough to help
 * (over 1 km). Never blocks the answer for long, and never asks again if location was refused.
 */
function herePosition(): Promise<{ lat: number; lng: number } | null> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 4000);
    navigator.geolocation.getCurrentPosition(
      (p) => {
        clearTimeout(timer);
        resolve(p.coords.accuracy <= 1000 ? { lat: p.coords.latitude, lng: p.coords.longitude } : null);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
      { enableHighAccuracy: true, timeout: 3500, maximumAge: 60_000 },
    );
  });
}
