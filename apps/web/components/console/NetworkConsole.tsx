"use client";

import { useState } from "react";
import type { MaintainerRow } from "@clara/network";
import { ApiError, BOX_STATUS, agoWords, postJson, useAnnouncer, useLive, useNow } from "../../lib/client";
import type { MaintainerResponse, StateSnapshot } from "../../lib/views";
import { StatusPill, TopBar } from "../TopBar";
import { ConsoleMap, MapLegend, helperCounts } from "./ConsoleMap";

const CALL_WORDS: Record<string, string> = { placed: "called", failed: "call failed", would_call: "would call (no Twilio)", capped: "skipped: hourly cap", quiet: "skipped: quiet hours" };
const human = (sku: string) => sku.replace(/_/g, " ");

/**
 * Network and boxes (feature 15, maintainer backend): an always-on live map of helpers and boxes, and each box's
 * status, battery, last heartbeat, supply counts against stock, low-stock and offline alerts, and restock.
 */
export function NetworkConsole() {
  const state = useLive<StateSnapshot>("/api/state");
  const maint = useLive<MaintainerResponse>("/api/maintainer");
  const now = useNow();
  const { announce, region } = useAnnouncer();
  const s = state.data;
  const m = maint.data;
  const counts = s ? helperCounts(s) : null;

  return (
    <div className="console">
      {region}
      <TopBar current="/maintainer" title="Clara Network">
        <span className="lbl">{state.status === "live" ? "● Live" : "Reconnecting"}</span>
      </TopBar>
      <main id="main" className="stage" aria-label="Live map">
        {s ? <ConsoleMap state={s} /> : null}
        {counts ? (
          <div className="float">
            <span className="lbl">Helpers nearby now</span>
            <span>
              <b className="big">{counts.available}</b> available · <b className="t-blue">{counts.onFoot}</b> on foot · <b>{counts.drivers}</b> drivers
            </span>
            <span className="small muted">{s!.site.name}</span>
          </div>
        ) : null}
        <MapLegend />
      </main>
      <aside className="side" aria-label="Boxes">
        <span className="lbl">Boxes · {m?.rows.length ?? "…"}</span>
        {state.error || maint.error ? <p className="error">{(state.error ?? maint.error)!.message}</p> : null}
        {m?.rows.map((row) => <BoxCard key={row.box.box_id} row={row} simulated={m.simulated_boxes.includes(row.box.box_id)} now={now} announce={announce} refresh={maint.refresh} />)}
        <span className="lbl" style={{ marginTop: 8 }}>
          Alerts
        </span>
        {m && m.alerts.length === 0 ? <p className="small muted">No low-stock or offline alerts.</p> : null}
        {m?.alerts.slice(0, 12).map((a, i) => (
          <div key={i} className="row between small">
            <span className={a.kind === "offline" ? "t-grey" : "t-amber"}>
              {a.kind === "offline" ? "Offline" : "Low stock"} · {a.box_name}
              {a.skus.length ? `: ${a.skus.map(human).join(", ")}` : ""}
            </span>
            <span className="muted mono">{agoWords(a.at, now)}</span>
          </div>
        ))}
        <span className="lbl" style={{ marginTop: 8 }}>
          Outreach
        </span>
        {m ? (
          <div className="stack small" style={{ gap: 4 }}>
            <span>
              Push: {m.outreach.push_devices} device{m.outreach.push_devices === 1 ? "" : "s"} subscribed
              <span className="muted"> · keys {m.outreach.push_vapid === "env" ? "from env" : "generated at start (reset on restart)"}</span>
            </span>
            <span className={m.outreach.calls_configured ? "t-green" : "t-grey"}>Calls: {m.outreach.calls_configured ? "Twilio configured" : "not configured"}</span>
            {m.outreach.calls.slice(0, 6).map((c, i) => (
              <div key={i} className="row between">
                <span>
                  {c.kind === "ride" ? "Ride" : "Alert"} · {c.to} · {CALL_WORDS[c.status] ?? c.status}
                </span>
                <span className="muted mono">{agoWords(c.at, now)}</span>
              </div>
            ))}
          </div>
        ) : null}
        {m?.simulated_boxes.length ? (
          <p className="small muted" style={{ marginTop: 8 }}>
            Demo: boxes marked SIMULATED get a simulated heartbeat every 30 s (CLARA_SIMULATED_BOXES).
          </p>
        ) : null}
      </aside>
    </div>
  );
}

function BoxCard({ row, simulated, now, announce, refresh }: { row: MaintainerRow; simulated: boolean; now: number; announce(t: string): void; refresh(): Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = BOX_STATUS[row.box.status] ?? { label: row.box.status, tone: "grey" };
  const low = row.supplies.items.filter((i) => i.low);
  async function restock() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await postJson(`/api/boxes/${encodeURIComponent(row.box.box_id)}/restock`);
      announce(`${row.box.name} restocked.`);
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't restock.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <article className={`card${row.box.status === "in_use" ? " urgent" : ""}`} aria-labelledby={`box-${row.box.box_id}`}>
      <div className="row between">
        <b id={`box-${row.box.box_id}`}>{row.box.name}</b>
        <StatusPill tone={st.tone}>{st.label}</StatusPill>
      </div>
      <span className="small muted">
        {row.box.battery_pct !== null ? `Battery ${Math.round(row.box.battery_pct)}%` : "Battery unknown"} · last seen {agoWords(row.box.last_seen_at, now)}
        {simulated ? " · " : ""}
        {simulated ? <span className="lbl">Simulated</span> : null}
      </span>
      {!row.online ? <span className="small t-grey">No contact for over 90 s: check power and Wi-Fi.</span> : null}
      {low.length ? <span className="small t-amber">Low: {low.map((i) => `${human(i.sku)} ${i.remaining} of ${i.stocked}`).join(" · ")}</span> : <span className="small t-green">Stock OK</span>}
      <details>
        <summary className="lbl" style={{ cursor: "pointer", minHeight: 32 }}>
          Supplies
        </summary>
        <table>
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col">Left</th>
              <th scope="col">Level</th>
            </tr>
          </thead>
          <tbody>
            {row.supplies.items.map((i) => (
              <tr key={i.sku}>
                <td>{human(i.sku)}</td>
                <td className="mono">
                  {i.remaining}/{i.stocked}
                </td>
                <td>
                  <div className="meter" data-tone={i.remaining === 0 ? "red" : i.low ? "amber" : undefined} aria-hidden="true">
                    <span style={{ width: `${i.stocked ? (100 * i.remaining) / i.stocked : 0}%` }} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {row.supplies.unlisted.length ? <p className="small muted">Also used (not in the kit list): {row.supplies.unlisted.map((u) => `${human(u.sku)} x${u.used}`).join(", ")}</p> : null}
        <p className="small muted">Restocked {row.supplies.restocked_at ? agoWords(row.supplies.restocked_at, now) : "never (counts from the stocked list)"}.</p>
      </details>
      <button type="button" className={`btn small${low.length ? " primary" : ""}`} aria-disabled={busy || undefined} onClick={() => void restock()}>
        {busy ? "Restocking…" : "Mark restocked"}
      </button>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </article>
  );
}
