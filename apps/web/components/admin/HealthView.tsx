"use client";

import { useEffect, useMemo, useState } from "react";
import { BOX_STATUS, agoWords, useNow } from "../../lib/client";
import type { AdminBox, AdminBoxesResponse } from "../../lib/admin";
import { LeafletMap, type MapPin } from "../LeafletMap";
import { StatusPill } from "../TopBar";
import { adminJson } from "./api";

const human = (sku: string) => sku.replace(/_/g, " ");

/** Map and health of every box in an area. */
export function HealthView({ area, setArea, token }: { area: string; setArea(a: string): void; token: string }) {
  const [data, setData] = useState<AdminBoxesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const refresh = () => void adminJson<AdminBoxesResponse>(`/api/admin/boxes?area=${encodeURIComponent(area)}`, token)
      .then((value) => { if (alive) { setData(value); setError(null); } })
      .catch((cause: Error) => { if (alive) setError(cause.message); });
    setData(null);
    refresh();
    const timer = setInterval(refresh, 5_000);
    return () => { alive = false; clearInterval(timer); };
  }, [area, token]);
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const d = data;
  const pins: MapPin[] = useMemo(
    () =>
      (d?.boxes ?? []).map((b) => ({
        id: b.box_id,
        at: b.at,
        kind: b.open_incident_id ? "emergency" : "box",
        tone: b.open_incident_id ? "red" : BOX_STATUS[b.status]?.tone ?? "grey",
        glyph: b.planned ? "K" : "+",
        title: b.name,
        detail: `${BOX_STATUS[b.status]?.label ?? b.status} · battery ${b.battery_pct ?? "?"}% · ${b.directions}`,
        pulse: !!b.open_incident_id,
      })),
    [d],
  );
  const s = d?.summary;
  const sel = d?.boxes.find((b) => b.box_id === selected) ?? null;
  return (
    <div className="adm-health">
      <main id="main" className="adm-stage" aria-label="Boxes map">
        {d ? <LeafletMap pins={pins} center={d.area.center} zoom={d.area.zoom} label={`Boxes in ${d.area.name}`} fill selected={selected} onSelect={setSelected} /> : <p className="muted pad">Loading…</p>}
        <div className="adm-legend">
          <span className="t-green">■ Ready</span> <span className="t-amber">■ Low stock</span> <span className="t-red">■ In use / emergency</span> <span className="muted">■ Offline</span> <span>K = planned kit</span>
        </div>
      </main>
      <aside className="adm-side" aria-label="Health">
        <label className="lbl" htmlFor="area">
          Area
        </label>
        <select id="area" className="adm-select" value={area} onChange={(e) => setArea(e.target.value)}>
          {(d?.areas ?? [{ id: "houston", name: "Houston · Downtown" }, { id: "la", name: "Los Angeles · Downtown" }, { id: "camp", name: "Kestrel Valley Camp (fictional)" }]).map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        {error ? <p className="error">{error}</p> : null}
        {s ? (
          <div className="adm-tiles">
            <Tile label="Boxes" value={s.total} />
            <Tile label="Ready" value={s.ready} tone="t-green" />
            <Tile label="Low stock" value={s.low_supplies} tone="t-amber" />
            <Tile label="In use" value={s.in_use} tone="t-red" />
            <Tile label="Offline" value={s.offline} tone="muted" />
            <Tile label="Open incidents" value={s.open_incidents} tone={s.open_incidents ? "t-red" : undefined} />
            <Tile label="Avg battery" value={s.avg_battery == null ? "–" : `${s.avg_battery}%`} />
            <Tile label="Battery < 30%" value={s.low_battery} tone={s.low_battery ? "t-amber" : undefined} />
          </div>
        ) : null}
        {sel ? <BoxDetail box={sel} now={now} /> : null}
        <span className="lbl">All boxes</span>
        {d && d.boxes.length === 0 ? <p className="muted small">No boxes in this area yet. Plan a building in the Urban planner and deploy it.</p> : null}
        <ul className="adm-list">
          {d?.boxes.map((b) => (
            <li key={b.box_id}>
              <button className={`adm-row${b.box_id === selected ? " on" : ""}`} onClick={() => setSelected(b.box_id)}>
                <span className="adm-row-name">{b.name}</span>
                <StatusPill tone={b.open_incident_id ? "red" : BOX_STATUS[b.status]?.tone ?? "grey"}>{b.open_incident_id ? "Emergency" : BOX_STATUS[b.status]?.label ?? b.status}</StatusPill>
                <span className="mono small muted">
                  {b.battery_pct ?? "–"}% · {agoWords(b.last_seen_at, now)}
                  {b.low_skus.length ? ` · low ${b.low_skus.map(human).join(", ")}` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="adm-tile">
      <span className="lbl">{label}</span>
      <b className={`big mono ${tone ?? ""}`}>{value}</b>
    </div>
  );
}

function BoxDetail({ box, now }: { box: AdminBox; now: number }) {
  return (
    <div className="adm-card">
      <span className="lbl">{box.box_id}</span>
      <h3>{box.name}</h3>
      <p className="small">{box.directions}</p>
      <p className="mono small">
        {BOX_STATUS[box.status]?.label ?? box.status} · battery {box.battery_pct ?? "–"}% · last seen {agoWords(box.last_seen_at, now)}
        {box.open_incident_id ? ` · open incident ${box.open_incident_id.slice(0, 8)}` : ""}
      </p>
      <div className="adm-supplies">
        {box.supplies.map((s) => (
          <div key={s.sku} className={s.low ? "t-amber" : undefined}>
            <span>{human(s.sku)}</span>
            <span className="mono">
              {s.remaining}/{s.stocked}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
