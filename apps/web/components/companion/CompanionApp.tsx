// Adapted from Sophi (github.com/mzhao1599/sophi), apps/web/src/components/PhoneApp.tsx, MayaPhone.tsx and
// apps/web/src/lib/usePhone.ts. Kept: one hook owns the talk with the server (first load, refresh on live changes,
// polling while the live line is down, refresh when the tab comes back); each change is announced once in a polite
// live region, compared with the last answer so nothing is said on load; a new alert plays the tone and vibrates
// (helpAlert.ts); the tab title says so while an alert is open; switching sections moves focus to the new heading.
// Sophi's six-digit circle join becomes the volunteer sign-up kept in localStorage; the screens follow the Field
// Kit phone design (Home, Map, Alerts, Profile).
"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Volunteer } from "@clara/contracts";
import { NEED_LABEL, SKILL_LABEL, api, km, postJson, useAnnouncer, useLive, useNow, type Live } from "../../lib/client";
import { buzz, playHelpTone, unlockAudioOnFirstTap } from "../../lib/helpAlert";
import type { InboxItem, InboxResponse, KitMapResponse, RideOfferItem } from "../../lib/views";
import { LeafletMap, type MapPin } from "../LeafletMap";
import { pinStatus } from "../KitMapView";
import { Tile } from "../TopBar";
import { AlertScreen, RideScreen } from "./AlertScreens";
import { SignUp } from "./SignUp";

export const VOLUNTEER_KEY = "clara.volunteer_id";
type Tab = "home" | "map" | "alerts" | "profile";

export function CompanionApp({ joinOnly = false }: { joinOnly?: boolean }) {
  // Read localStorage after mount so the server render and the first client render match.
  const [volunteerId, setVolunteerId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setVolunteerId(window.localStorage.getItem(VOLUNTEER_KEY));
  }, []);

  if (volunteerId === undefined) return <p className="lbl">Opening Clara…</p>;
  if (volunteerId === null || joinOnly)
    return (
      <SignUp
        already={volunteerId !== null}
        onJoined={(v) => {
          window.localStorage.setItem(VOLUNTEER_KEY, v.volunteer_id);
          if (joinOnly) window.location.assign("/app");
          else setVolunteerId(v.volunteer_id);
        }}
      />
    );
  return (
    <Signed
      volunteerId={volunteerId}
      onForget={() => {
        window.localStorage.removeItem(VOLUNTEER_KEY);
        setVolunteerId(null);
      }}
    />
  );
}

const openRide = (r: RideOfferItem, id: string) => r.ride.winner?.driver_id === id || (r.my_offer?.state === "offered" && !r.ride.winner);

function Signed({ volunteerId, onForget }: { volunteerId: string; onForget(): void }) {
  const live = useLive<InboxResponse>(`/api/volunteers/${encodeURIComponent(volunteerId)}/inbox`, { pollMs: 3_000 });
  const { announce, region } = useAnnouncer();
  const [tab, setTab] = useState<Tab>("home");
  const now = useNow(1_000);
  const inbox = live.data;
  const items = inbox?.items ?? [];
  const rides = (inbox?.rides ?? []).filter((r) => openRide(r, volunteerId) || r.my_offer?.state === "lost");

  // Each change is said once, compared with the last answer (`undefined` until the first, so nothing on load).
  // A brand-new alert or ride offer also plays the tone, vibrates and opens the Alerts section.
  const last = useRef<{ alerts: Map<string, InboxItem>; offers: Set<string> } | undefined>(undefined);
  useEffect(() => {
    if (!inbox) return;
    const prev = last.current;
    const alerts = new Map(inbox.items.map((i) => [i.alert.alert_id, i]));
    const offers = new Set(inbox.rides.filter((r) => r.my_offer?.state === "offered").map((r) => `${r.ride.ride_id}/${r.my_offer!.offered_at}`));
    last.current = { alerts, offers };
    if (!prev) return;
    let fresh = false;
    for (const [id, item] of alerts) {
      const before = prev.alerts.get(id);
      const where = item.box?.name ?? item.incident.box_id;
      if (!before) {
        fresh = true;
        announce(`New emergency alert: ${NEED_LABEL[item.incident.need] ?? item.incident.need} at ${where}.`);
      } else if (before.coming_line !== item.coming_line && item.coming_line) announce(`At ${where}: ${item.coming_line}`);
    }
    for (const [id, item] of prev.alerts) if (!alerts.has(id)) announce(`The emergency at ${item.box?.name ?? item.incident.box_id} has closed.`);
    for (const o of offers) {
      if (!prev.offers.has(o)) {
        fresh = true;
        announce("New ride request: take a patient to hospital.");
      }
    }
    if (fresh) {
      playHelpTone();
      buzz();
      setTab("alerts");
    }
  }, [inbox, announce]);

  useEffect(() => unlockAudioOnFirstTap(), []);

  const waiting = items.filter((i) => i.alert.state === "sent" || i.alert.state === "shown").length + rides.filter((r) => r.my_offer?.state === "offered" && !r.ride.winner).length;
  useEffect(() => {
    if (waiting === 0) return;
    const before = document.title;
    document.title = `(${waiting}) Emergency alert · Clara`;
    return () => {
      document.title = before;
    };
  }, [waiting]);

  // Switching sections moves focus to the new section's heading (not on first load).
  const shown = useRef(tab);
  useLayoutEffect(() => {
    if (shown.current === tab) return;
    shown.current = tab;
    document.querySelector<HTMLElement>("#companion-panel h1")?.focus();
  }, [tab]);

  if (live.error?.status === 404)
    return (
      <section className="stack">
        <h1>Sign up again</h1>
        <p className="muted">This demo server doesn&apos;t know your sign-up any more (it keeps everything in memory and may have restarted).</p>
        <button type="button" className="btn primary block huge" onClick={onForget}>
          Sign up again
        </button>
      </section>
    );

  const tabs: { id: Tab; label: string }[] = [
    { id: "home", label: "Home" },
    { id: "map", label: "Map" },
    { id: "alerts", label: "Alerts" },
    { id: "profile", label: "Profile" },
  ];

  return (
    <>
      {region}
      {live.error ? <p className="error">{live.error.message} Showing what the server said last.</p> : null}
      <div id="companion-panel" className="stack" style={{ gap: 14 }}>
        {!inbox ? <p className="lbl">Loading…</p> : null}
        {inbox && tab === "home" ? <HomeTab inbox={inbox} live={live} waiting={waiting} goAlerts={() => setTab("alerts")} /> : null}
        {inbox && tab === "map" ? <MapTab inbox={inbox} goAlerts={() => setTab("alerts")} /> : null}
        {inbox && tab === "alerts" ? (
          <>
            {rides.map((r) => (
              <RideScreen key={r.ride.ride_id} item={r} volunteerId={volunteerId} refresh={live.refresh} announce={announce} now={now} />
            ))}
            {items.map((item) => (
              <AlertScreen key={item.alert.alert_id} item={item} volunteerId={volunteerId} refresh={live.refresh} announce={announce} now={now} />
            ))}
            {items.length === 0 && rides.length === 0 ? (
              <section className="stack">
                <h1>Alerts</h1>
                <div className="card">
                  <b>No emergencies near you right now.</b>
                  <span className="muted small">Keep this page open. A new alert opens here with a tone and a buzz.</span>
                  <span className="lbl">{live.status === "live" ? "Live · connected" : "Checking every few seconds"}</span>
                </div>
              </section>
            ) : null}
          </>
        ) : null}
        {inbox && tab === "profile" ? <Profile volunteer={inbox.volunteer} vehicle={inbox.home.vehicle} onForget={onForget} /> : null}
      </div>
      <nav aria-label="Sections" className="bottom-nav">
        <div>
          {tabs.map((t) => (
            <button key={t.id} type="button" aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "alerts" && waiting ? <span className="dot"> ● {waiting}</span> : null}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}

function HomeTab({ inbox, live, waiting, goAlerts }: { inbox: InboxResponse; live: Live<InboxResponse>; waiting: number; goAlerts(): void }) {
  const v = inbox.volunteer;
  const h = inbox.home;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle(available: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/volunteers/${encodeURIComponent(v.volunteer_id)}/availability`, { available });
      await live.refresh();
    } catch {
      setError("Couldn't change it. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const radius = h.alert_radius_km >= 1 ? `${h.alert_radius_km} km` : `${h.alert_radius_km * 1000} m`;
  return (
    <section className="stack" aria-labelledby="home-h" style={{ gap: 14 }}>
      <div className="row between">
        <h1 id="home-h" tabIndex={-1} style={{ margin: 0 }}>
          Hi, {v.name}
        </h1>
        <span className="lbl">{live.status === "live" ? "● Live" : "Checking"}</span>
      </div>
      {waiting ? (
        <button type="button" className="btn primary block huge" onClick={goAlerts}>
          {waiting === 1 ? "1 alert waiting" : `${waiting} alerts waiting`}
        </button>
      ) : null}
      <div className="card" style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
        <div className="stack" style={{ gap: 2 }}>
          <b>Available to help</b>
          <span className="muted small">Alerts within {radius}</span>
        </div>
        <label className="switch">
          <span className="visually-hidden">Available to help</span>
          <input type="checkbox" role="switch" checked={v.available} aria-disabled={busy || undefined} onChange={(e) => void toggle(e.target.checked)} />
          <span aria-hidden="true" />
        </label>
      </div>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className="tiles">
        <Tile label="Helpers near you" value={h.helpers_nearby} />
        <Tile label="Kits within 1 km" value={h.kits_nearby} />
      </div>
      <div className="card">
        <span className="lbl">Your skills</span>
        <div className="chips">
          {v.skills.map((s) => (
            <span key={s} className="chip-static">
              {SKILL_LABEL[s] ?? s}
            </span>
          ))}
          {v.vehicle_seats > 0 ? <span className="chip-static">{vehicleWord(h.vehicle)} · {v.vehicle_seats} seats</span> : null}
          {v.languages.length ? <span className="chip-static">{v.languages.join(", ").toUpperCase()}</span> : null}
        </div>
      </div>
      <div className="card">
        <span className="lbl">Last response</span>
        {h.last_response ? (
          <span>
            {new Date(h.last_response.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · {h.last_response.box_name} ·{" "}
            {h.last_response.state === "arrived" ? "you arrived" : "you said you were coming"}
            {h.last_response.how ? ` · closed (${h.last_response.how})` : ""}
          </span>
        ) : (
          <span className="muted">None yet.</span>
        )}
      </div>
    </section>
  );
}

const vehicleWord = (v: string) => ({ car: "Car", van: "Van", motorbike: "Motorbike", none: "No vehicle" })[v] ?? v;

function MapTab({ inbox, goAlerts }: { inbox: InboxResponse; goAlerts(): void }) {
  const [data, setData] = useState<KitMapResponse | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api<KitMapResponse>("/api/kit-map").then((d) => live && setData(d), () => undefined);
    void load();
    const t = setInterval(load, 10_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  const me = inbox.volunteer.location;
  const active = inbox.items[0] ?? null;
  const pins = useMemo<MapPin[]>(() => {
    if (!data) return [];
    const out: MapPin[] = [];
    data.helpers.forEach((h, i) => out.push({ id: `h${i}`, at: h.at, kind: "volunteer", tone: h.driver ? "white" : "blue", title: h.driver ? "Helper with a vehicle" : "Helper", detail: "Available volunteer (position rounded)" }));
    for (const p of data.pins) {
      const s = pinStatus(p);
      out.push({ id: p.box_id, at: p.location, kind: "box", tone: s.tone === "red" ? "red" : s.tone, glyph: "+", title: `${p.name}: ${s.label}`, detail: p.directions });
    }
    for (const e of data.emergencies) out.push({ id: e.incident_id, at: e.at, kind: "emergency", tone: "red", title: `Emergency: ${NEED_LABEL[e.need] ?? e.need}`, detail: e.box_name, pulse: true });
    out.push({ id: "you", at: me, kind: "you", tone: "green", title: "You", detail: "Your sign-up location" });
    return out;
  }, [data, me]);
  const rings = useMemo(() => (data?.emergencies ?? []).map((e) => ({ at: e.at, radiusM: 500 })), [data]);
  return (
    <section className="stack" aria-labelledby="map-h">
      <h1 id="map-h" tabIndex={-1} className="visually-hidden">
        Map
      </h1>
      <div className="map-wrap">
        {data ? <LeafletMap pins={pins} rings={rings} center={active?.box?.location ?? me} zoom={15} tall label="Map of helpers, kits and emergencies near you" /> : <div className="map tall" />}
        {data ? (
          <div className="float" style={{ right: 16 }}>
            <b className="mono">
              {data.helpers.length} helpers · {data.pins.length} kits
            </b>
            <span className="muted small">
              {data.emergencies.length} active emergenc{data.emergencies.length === 1 ? "y" : "ies"}
            </span>
          </div>
        ) : null}
      </div>
      <div className="sheet">
        {active ? (
          <>
            <span className="lbl t-red">Active emergency</span>
            <h2 style={{ margin: 0 }}>
              {NEED_LABEL[active.incident.need] ?? active.incident.need} · {active.box?.name ?? active.incident.box_id}
            </h2>
            <span className="muted">
              {active.distance_km !== null ? km(active.distance_km) : ""}
              {active.scene.tourniquet_at ? ` · tourniquet on since ${new Date(active.scene.tourniquet_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}` : ""}
            </span>
            <div className="chips">
              <span className="chip-static">{active.scene.coming + active.scene.arrived} helpers going</span>
            </div>
            <button type="button" className="btn primary block huge" onClick={goAlerts}>
              {active.alert.state === "coming" ? "On the way" : "Open alert"}
            </button>
          </>
        ) : (
          <>
            <span className="lbl">Nearby kits</span>
            {(data?.pins ?? []).map((p) => {
              const s = pinStatus(p);
              return (
                <div key={p.box_id} className="row between">
                  <span>{p.name}</span>
                  <span className={`lbl t-${s.tone}`}>{s.label}</span>
                </div>
              );
            })}
          </>
        )}
      </div>
    </section>
  );
}

function Profile({ volunteer, vehicle, onForget }: { volunteer: Volunteer; vehicle: string; onForget(): void }) {
  return (
    <section aria-labelledby="me-h" className="stack">
      <h1 id="me-h" tabIndex={-1}>
        {volunteer.name}
      </h1>
      <div className="card">
        <span className="lbl">Skills</span>
        <span>{volunteer.skills.map((s) => SKILL_LABEL[s] ?? s).join(", ")}</span>
        <span className="lbl">Languages</span>
        <span>{volunteer.languages.join(", ").toUpperCase() || "None given"}</span>
        <span className="lbl">Vehicle</span>
        <span>{volunteer.vehicle_seats > 0 ? `${vehicleWord(vehicle)}, ${volunteer.vehicle_seats} seats` : "No vehicle"}</span>
        <span className="lbl">Reach me by</span>
        <span>{volunteer.channel === "app" ? "This app" : volunteer.channel}</span>
      </div>
      <button type="button" className="btn block" onClick={onForget}>
        Sign out on this phone
      </button>
      <p className="small muted">Signing out forgets your id on this phone only.</p>
    </section>
  );
}
