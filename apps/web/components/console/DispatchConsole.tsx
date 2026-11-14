"use client";

import { useEffect, useState } from "react";
import { ALERT_STATE, ApiError, NEED_LABEL, agoWords, clockShort, postJson, useAnnouncer, useLive, useNow } from "../../lib/client";
import type { DriverOption } from "../../lib/rides";
import type { IncidentDetail, StateSnapshot } from "../../lib/views";
import { StatusPill, Tile, TopBar } from "../TopBar";
import { ConsoleMap, MapLegend, helperCounts } from "./ConsoleMap";

const ESCALATION: Record<string, string> = { first: "First 3 alerted", next: "Next 3 alerted (60 s, no reply)", all: "Everyone with the skill alerted (120 s)" };
const VEHICLE: Record<string, string> = { car: "car", van: "van", motorbike: "motorbike", none: "no vehicle" };

/**
 * Dispatch and rides (features 12, 17, 18 and volunteer rides): emergencies, live timeline, alerts with their states
 * and escalation, "said at the box", the triage board, the scene report link, and the ride plan: suggested driver
 * with reasons, approve and offer, reassign, backups. The map of helpers is always on.
 */
export function DispatchConsole() {
  const state = useLive<StateSnapshot>("/api/state");
  const [selected, setSelected] = useState<string | null>(null);
  const detail = useLive<IncidentDetail>(selected ? `/api/incidents/${encodeURIComponent(selected)}` : null);
  const { announce, region } = useAnnouncer();
  const now = useNow(1_000);
  const s = state.data;

  // Pick the newest open incident when nothing is selected (or the selection vanished after a restart).
  useEffect(() => {
    if (!s) return;
    if (selected && s.incidents.some((i) => i.incident.incident_id === selected)) return;
    const open = s.incidents.find((i) => !i.incident.closed) ?? s.incidents[0];
    setSelected(open?.incident.incident_id ?? null);
  }, [s, selected]);

  const open = s?.incidents.filter((i) => !i.incident.closed) ?? [];
  const counts = s ? helperCounts(s) : null;
  const d = detail.data && detail.data.incident.incident_id === selected ? detail.data : null;

  return (
    <div className="console">
      {region}
      <TopBar current="/dashboard" title="Clara Dispatch">
        <span className={open.length ? "lbl t-red" : "lbl"}>
          ● {open.length} active emergenc{open.length === 1 ? "y" : "ies"}
        </span>
        {counts && s ? (
          <span className="small muted">
            {counts.available} helpers · {counts.drivers} drivers · ambulance {s.ambulance_eta_min === null ? "not known" : `${s.ambulance_eta_min}+ min`}
          </span>
        ) : null}
        <DemoSos boxes={s?.boxes.map((b) => ({ id: b.box_id, name: b.name })) ?? []} announce={announce} onOpened={(id) => setSelected(id)} refresh={state.refresh} />
      </TopBar>
      <main id="main" className="stage" aria-label="Live map and emergencies">
        {s ? <ConsoleMap state={s} selectedIncident={selected} ride={d?.ride ?? null} onSelectIncident={setSelected} /> : null}
        <div className="float" style={{ maxHeight: "60%", overflowY: "auto", width: 340 }}>
          <span className="lbl">Emergencies</span>
          {s && s.incidents.length === 0 ? <span className="small muted">None yet. Use Demo SOS to start one.</span> : null}
          <ul className="list" aria-label="Emergencies">
            {s?.incidents.slice(0, 12).map((i) => (
              <li key={i.incident.incident_id} style={{ borderTop: 0, padding: "3px 0" }}>
                <button type="button" className="item" aria-current={selected === i.incident.incident_id ? "true" : undefined} onClick={() => setSelected(i.incident.incident_id)}>
                  <b className={i.incident.closed ? "muted" : undefined}>
                    {NEED_LABEL[i.incident.need] ?? i.incident.need} · {i.box?.name ?? i.incident.box_id}
                  </b>
                  <span className="small muted">
                    {i.incident.closed ? `Closed (${i.incident.closed.how})` : i.coming_line ?? (i.escalation.flag ? "No reply: escalated to everyone" : "Waiting for a helper")}
                    {i.scene.tourniquet_at ? ` · TQ ${clockShort(i.scene.tourniquet_at)}` : ""} · {agoWords(i.incident.opened_at, now)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <MapLegend />
      </main>
      <aside className="side" aria-label="Selected emergency">
        {state.error ? <p className="error">{state.error.message}</p> : null}
        {d ? <IncidentPanel d={d} now={now} announce={announce} refresh={detail.refresh} /> : <p className="muted">{s ? "No emergency selected." : "Loading…"}</p>}
      </aside>
    </div>
  );
}

function DemoSos({ boxes, announce, onOpened, refresh }: { boxes: { id: string; name: string }[]; announce(t: string): void; onOpened(id: string): void; refresh(): Promise<void> }) {
  const [box, setBox] = useState("box-clinic");
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      const r = await postJson<{ incident: { incident_id: string } | null }>(`/api/demo/sos?box=${encodeURIComponent(box)}&need=bleeding`);
      announce("Demo SOS sent.");
      if (r.incident) onOpened(r.incident.incident_id);
      await refresh();
    } catch (e) {
      announce(e instanceof ApiError ? e.message : "Demo SOS failed.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="row no-print" style={{ gap: 6 }}>
      <label className="visually-hidden" htmlFor="demo-box">
        Box for the demo SOS
      </label>
      <select id="demo-box" value={box} onChange={(e) => setBox(e.target.value)} style={{ width: 160, minHeight: 44 }}>
        {boxes.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <button type="button" className="btn small" aria-disabled={busy || undefined} onClick={() => void go()}>
        {busy ? "Sending…" : "Demo SOS"}
      </button>
    </span>
  );
}

function IncidentPanel({ d, now, announce, refresh }: { d: IncidentDetail; now: number; announce(t: string): void; refresh(): Promise<void> }) {
  const { incident, report, scene } = d;
  const closed = incident.closed;
  const triage = report?.triage ?? [];
  const tagOf = (text: string) => (/: (red|yellow|green|black)/.exec(text)?.[1] ?? "");
  const [busy, setBusy] = useState(false);

  async function closeBox() {
    if (busy) return;
    setBusy(true);
    try {
      await postJson(`/api/demo/close?box=${encodeURIComponent(incident.box_id)}`);
      announce("Demo: box closed.");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" aria-labelledby="inc-h" style={{ gap: 12 }}>
      <span className={`lbl ${closed ? "" : "t-red"}`}>{closed ? `Closed · ${closed.how}` : `Active · opened ${agoWords(incident.opened_at, now)}`}</span>
      <h1 id="inc-h" style={{ fontSize: "1.4rem", margin: 0 }}>
        {NEED_LABEL[incident.need] ?? incident.need} · {d.box?.name ?? incident.box_id}
      </h1>
      {!closed ? (
        <span className={`small ${d.escalation.flag ? "t-red" : "muted"}`}>
          {ESCALATION[d.escalation.level]}
          {d.escalation.flag === "no_reply" ? " · NO REPLY: call for help another way" : d.escalation.flag === "nobody_matched" ? " · NOBODY MATCHED nearby" : ""}
        </span>
      ) : null}
      <div className="tiles">
        <Tile label="TQ on" value={scene.tourniquet_at ? clockShort(scene.tourniquet_at) : "—"} tone={scene.tourniquet_at ? "red" : undefined} />
        <Tile label="Pulse (sensor)" value={scene.pulse?.bpm ?? "—"} />
        <Tile label="Alerted" value={scene.alerted} />
        <Tile label="Ambulance" value={scene.ambulance_eta_min === null ? "?" : `${scene.ambulance_eta_min}+ min`} />
      </div>

      <div className="card">
        <span className="lbl">Said at the box</span>
        <span>{d.coming_line ? `"${d.coming_line}"` : "Nothing about help yet: nobody has accepted."}</span>
        <span className="small muted">{d.ride?.winner ? `"${d.ride.winner.driver_name}, a volunteer driver, accepted the ride to hospital."` : "Ride not promised yet."}</span>
        {d.messages.map((m, i) => (
          <span key={i} className="small">
            <b>{m.from}</b> to the box: {m.text} <span className="muted mono">{clockShort(m.at)}</span>
          </span>
        ))}
      </div>

      <span className="lbl">Helpers alerted</span>
      {incident.alerts.length === 0 ? <p className="small muted">Nobody alerted yet.</p> : null}
      {incident.alerts.map((a) => {
        const st = ALERT_STATE[a.state] ?? { label: a.state, tone: "grey" };
        return (
          <div key={a.alert_id} className="row between">
            <span>
              {a.volunteer_name}
              {a.eta_minutes !== null && a.state === "coming" ? <span className="muted mono"> · {Math.max(1, a.eta_minutes)} min</span> : null}
            </span>
            <StatusPill tone={st.tone}>{st.label}</StatusPill>
          </div>
        );
      })}
      {!closed && d.candidates.length ? <span className="small muted">Next if no reply: {d.candidates.slice(0, 3).map((c) => c.name).join(", ")}</span> : null}

      {!closed ? <RidePlan d={d} now={now} announce={announce} refresh={refresh} /> : null}

      <span className="lbl">Live timeline</span>
      {report && report.timeline.length ? (
        <div className="stack" style={{ gap: 4 }}>
          {[...report.timeline].reverse().map((l, i) => (
            <div key={i} className="tl small">
              <span className="when">{clockShort(l.at)}</span>
              <span>
                <span className="label-tag" data-label={l.label}>
                  {l.label}
                </span>
                {l.text.replace(/^\d{1,2}:\d{2}\s?[AP]M\s/, "")}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="small muted">No box events yet.</p>
      )}

      <span className="lbl">Triage board</span>
      <div className="triage">
        {(["red", "yellow", "green", "black"] as const).map((tag) => (
          <div key={tag} className={`tg-${tag}`}>
            <b className="mono">{tag.toUpperCase()}</b>
            {triage
              .filter((t) => tagOf(t.text) === tag)
              .map((t, i) => (
                <div key={i}>{t.text.split(":")[0]}</div>
              ))}
          </div>
        ))}
      </div>

      <div className="row">
        <a className="btn small" href={`/report/${encodeURIComponent(incident.report_token)}`} target="_blank" rel="noreferrer">
          EMS scene report
        </a>
        {!closed ? (
          <button type="button" className="btn small no-print" aria-disabled={busy || undefined} onClick={() => void closeBox()}>
            Demo: close the box
          </button>
        ) : null}
      </div>
    </section>
  );
}

function RidePlan({ d, now, announce, refresh }: { d: IncidentDetail; now: number; announce(t: string): void; refresh(): Promise<void> }) {
  const ride = d.ride && d.ride.state !== "cancelled" ? d.ride : null;
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run(kind: string, path: string, body?: unknown, said?: string) {
    if (busy) return;
    setBusy(kind);
    setError(null);
    try {
      await postJson(path, body);
      if (said) announce(said);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "That didn't work. Try again.");
    } finally {
      await refresh();
      setBusy(null);
    }
  }
  const rid = ride ? encodeURIComponent(ride.ride_id) : "";

  if (!ride)
    return (
      <div className="card">
        <span className="lbl">Ride to hospital</span>
        <label className="field">
          <span>Patient note (optional)</span>
          <input type="text" maxLength={120} value={note} onChange={(e) => setNote(e.target.value)} placeholder="1 adult, can sit up" />
        </label>
        <button type="button" className="btn primary block" aria-disabled={busy !== null || undefined} onClick={() => void run("plan", "/api/rides", { incident_id: d.incident.incident_id, ...(note.trim() ? { note: note.trim() } : {}) }, "Ride plan started.")}>
          {busy ? "Planning…" : "Plan a ride"}
        </button>
        {error ? <p className="error" role="alert">{error}</p> : null}
      </div>
    );

  const openOffers = ride.offers.filter((f) => f.state === "offered");
  return (
    <div className="card">
      <span className="lbl">Ride plan · {d.box?.name ?? d.incident.box_id}</span>
      {ride.note ? <span className="small muted">{ride.note}</span> : null}
      {ride.winner ? (
        <>
          <b className="t-green">
            {ride.winner.driver_name} accepted · pickup {Math.max(1, ride.winner.pickup_minutes)} min · hospital {ride.hospital_minutes ?? "?"} min
          </b>
          <span className="small muted">To {ride.hospital.name}.</span>
        </>
      ) : ride.suggested ? (
        <DriverCard o={ride.suggested} suggested />
      ) : (
        <span className="small t-amber">No suitable free driver left.</span>
      )}
      {!ride.winner && ride.suggested ? (
        <div className="row">
          <button type="button" className="btn primary grow" aria-disabled={busy !== null || undefined} onClick={() => void run("approve", `/api/rides/${rid}/approve`, { driver_id: ride.suggested!.driver_id }, `Ride offered to ${ride.suggested!.name}.`)}>
            {busy === "approve" ? "Offering…" : "Approve and offer"}
          </button>
          <button type="button" className="btn" aria-disabled={busy !== null || undefined} onClick={() => void run("reassign", `/api/rides/${rid}/reassign`, undefined, "Reassigned.")}>
            Reassign
          </button>
        </div>
      ) : null}
      {openOffers.length || ride.offers.length ? (
        <div className="stack" style={{ gap: 4 }}>
          <span className="lbl">Offers</span>
          {ride.offers.map((f, i) => {
            const left = Math.max(0, Math.ceil((Date.parse(f.expires_at) - now) / 1000));
            const tone = f.state === "accepted" ? "green" : f.state === "offered" ? "blue" : f.state === "declined" ? "amber" : "grey";
            return (
              <div key={i} className="row between small">
                <span>
                  {f.driver_name}
                  {f.state === "offered" ? <span className="muted mono"> · {left} s left</span> : null}
                </span>
                <StatusPill tone={tone}>{f.state}</StatusPill>
              </div>
            );
          })}
        </div>
      ) : null}
      {!ride.winner && ride.backups.length ? (
        <div className="stack" style={{ gap: 6 }}>
          <span className="lbl">Backups</span>
          {ride.backups.map((b) => (
            <div key={b.driver_id} className="row between small">
              <span>
                {b.name} · {VEHICLE[b.vehicle] ?? b.vehicle}
              </span>
              {b.suitable ? (
                <span className="row" style={{ gap: 6 }}>
                  <span className="muted mono">{b.pickup_minutes} min</span>
                  <button type="button" className="btn small" aria-disabled={busy !== null || undefined} onClick={() => void run("approve", `/api/rides/${rid}/approve`, { driver_id: b.driver_id }, `Ride offered to ${b.name}.`)}>
                    Offer
                  </button>
                </span>
              ) : (
                <span className="muted">not suitable</span>
              )}
            </div>
          ))}
        </div>
      ) : null}
      <button type="button" className="btn small" aria-disabled={busy !== null || undefined} onClick={() => void run("cancel", `/api/rides/${rid}/cancel`, undefined, "Ride cancelled.")}>
        Cancel ride
      </button>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </div>
  );
}

function DriverCard({ o, suggested }: { o: DriverOption; suggested?: boolean }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <b>
        {suggested ? "Suggested: " : ""}
        {o.name} · {VEHICLE[o.vehicle] ?? o.vehicle}, {o.seats} seats
      </b>
      <span className="small muted">
        Pickup {o.pickup_minutes} min · hospital {o.hospital_minutes} min
      </span>
      <span className="small muted">Why: {o.reasons.join(", ")}</span>
    </div>
  );
}

