"use client";

import type { ReportLine, SceneReport } from "@clara/network";
import { NEED_LABEL, clock, useLive, useNow } from "../lib/client";

/**
 * The EMS scene report (feature 13), reached by its secret link from the console. Every line shows its label
 * (reported / observed / done) and time, exactly as the server built it from the box's event log; nothing here is
 * computed except the tourniquet's elapsed time. Live while open, and print-friendly.
 */
export function ReportView({ token }: { token: string }) {
  const live = useLive<{ report: SceneReport; server_time: string }>(`/api/report/${encodeURIComponent(token)}`, { pollMs: 5_000 });
  const now = useNow(15_000);
  const r = live.data?.report;

  return (
    <main id="main" className="page stack" style={{ maxWidth: 900, gap: 14 }}>
      <header className="stack" style={{ gap: 6 }}>
        <span className="lbl t-red">Simulation · demo · not a real emergency record</span>
        <h1 style={{ margin: 0 }}>EMS scene report</h1>
        <p className="notice">{r?.notice ?? "Clara proof of concept. The 911 call shown on the box is a simulation; no emergency number was dialed."}</p>
      </header>
      {live.error ? <p className="error">{live.error.status === 404 ? "No scene report at this link. The demo server may have restarted." : live.error.message}</p> : null}
      {!r && !live.error ? <p className="lbl">Loading…</p> : null}
      {r ? (
        <>
          <div className="row between">
            <div className="stack" style={{ gap: 2 }}>
              <b className="mono" style={{ fontSize: "1.2rem" }}>
                {NEED_LABEL[r.need] ?? r.need} · {r.box.name}
              </b>
              <span className="small muted">
                {r.box.directions} · SOS {clock(r.opened_at)} · {r.closed ? `closed ${clock(r.closed.at)} (${r.closed.how})` : "open"}
              </span>
            </div>
            <span className="row no-print">
              <span className="lbl">{live.status === "live" ? "● Live" : "Refreshing"}</span>
              <button type="button" className="btn small" onClick={() => window.print()}>
                Print
              </button>
            </span>
          </div>

          <section className="tq" aria-label="Tourniquet guidance timer">
            <span className="lbl t-red">Tourniquet guidance timer</span>
            {r.tourniquet ? (
              <>
                <strong>Started {clock(r.tourniquet.at)}</strong>
                <span>
                  About {Math.max(0, Math.round((now - Date.parse(r.tourniquet.at)) / 60_000))} min since the box started this timer; application is unconfirmed. <Label l={r.tourniquet} />
                </span>
              </>
            ) : (
              <strong style={{ fontSize: "1.2rem" }}>No tourniquet timer recorded</strong>
            )}
          </section>

          <section className="card flat" aria-labelledby="mist-h">
            <h2 id="mist-h">MIST</h2>
            <Lines title="M · Mechanism" lines={r.mist.mechanism} empty="Nothing reported." />
            <Lines title="I · Injuries" lines={r.mist.injuries} empty="Nothing reported." />
            <Lines title="S · Signs" lines={r.mist.signs} empty="No device readings." />
            <Lines title="T · Treatment status" lines={r.mist.treatment} empty="No treatment confirmed." />
            {r.mist.treatment.length ? <p className="small muted">These are box guidance timers, not confirmation that treatment was given.</p> : null}
          </section>

          <section className="card flat" aria-labelledby="who-h">
            <h2 id="who-h">Helpers</h2>
            {r.responders.length ? (
              <ul className="list">
                {r.responders.map((x) => (
                  <li key={x.alert_id}>
                    <span className={`pill`} data-tone={x.state === "arrived" ? "green" : "blue"}>
                      {x.state}
                    </span>{" "}
                    {x.text}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">Nobody has accepted yet.</p>
            )}
            {r.coming_line ? <p className="small muted">The box said: &ldquo;{r.coming_line}&rdquo;</p> : null}
          </section>

          <section className="card flat" aria-labelledby="tri-h">
            <h2 id="tri-h">Triage</h2>
            <Lines lines={r.triage} empty="No triage tags." />
          </section>

          <section className="card flat" aria-labelledby="sup-h">
            <h2 id="sup-h">Supplies used</h2>
            <Lines lines={r.supplies_used} empty="None confirmed." />
            {r.photos.length ? (
              <>
                <h3>Photos</h3>
                <Lines lines={r.photos} empty="" />
              </>
            ) : null}
          </section>

          <section className="card flat" aria-labelledby="tl-h">
            <h2 id="tl-h">Timeline</h2>
            <Lines lines={r.timeline} empty="No events." stripTime />
          </section>
          <p className="small muted">Every line cites a box event and is checked against the event log before this report is served.</p>
        </>
      ) : null}
    </main>
  );
}

function Label({ l }: { l: ReportLine }) {
  return (
    <span className="label-tag" data-label={l.label}>
      {l.label}
    </span>
  );
}

function Lines({ title, lines, empty, stripTime }: { title?: string; lines: ReportLine[]; empty: string; stripTime?: boolean }) {
  return (
    <div style={{ marginBottom: 10 }}>
      {title ? <h3 style={{ marginTop: 8 }}>{title}</h3> : null}
      {lines.length ? (
        <ul className="list">
          {lines.map((l, i) => (
            <li key={i} className="tl">
              <span className="when">{clock(l.at)}</span>
              <span>
                <Label l={l} />
                {stripTime ? l.text.replace(/^\d{1,2}:\d{2}\s?[AP]M\s/, "") : l.text}
              </span>
            </li>
          ))}
        </ul>
      ) : empty ? (
        <p className="small muted">{empty}</p>
      ) : null}
    </div>
  );
}
