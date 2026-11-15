"use client";

import { useEffect, useMemo, useState } from "react";
import type { RuralPlan, Settlement } from "@clara/placement";
import { LeafletMap, type MapPin } from "../LeafletMap";
import { adminJson } from "./api";

interface Dataset {
  id: string;
  name: string;
  kind: string;
  source: string;
  boxes: number;
  reachKm: number;
  reachLabel: string;
  center: { lat: number; lng: number };
  zoom: number;
  settlements: Settlement[];
}

/** Road distance = straight line × this (the planner's ROAD_FACTOR, sent by GET /api/admin/rural). */
type Datasets = { datasets: Dataset[]; roadFactor?: number };

const people = (n: number) => n.toLocaleString("en-US");

/**
 * Rural planner: give it a place and a box budget; each box goes to the population-weighted centre of the people nearest
 * it and is mounted at the closest settlement. Real places: UNHCR camp data (Kutupalong) and the 2020 Census (Perry County).
 */
export function RuralView({ token }: { token: string }) {
  const [datasets, setDatasets] = useState<Dataset[] | null>(null);
  const [roadFactor, setRoadFactor] = useState(1.3);
  const [id, setId] = useState("kutupalong");
  const [boxes, setBoxes] = useState("12");
  const [reach, setReach] = useState("0.8");
  const [plan, setPlan] = useState<RuralPlan | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    adminJson<Datasets>("/api/admin/rural", token)
      .then((r) => {
        setDatasets(r.datasets);
        if (r.roadFactor) setRoadFactor(r.roadFactor);
      })
      .catch((e: Error) => setErr(e.message));
  }, [token]);

  const d = datasets?.find((x) => x.id === id) ?? null;
  const pick = (next: string) => {
    const n = datasets?.find((x) => x.id === next);
    setId(next);
    setPlan(null);
    if (n) {
      setBoxes(String(n.boxes));
      setReach(String(n.reachKm));
    }
  };

  const run = async () => {
    setErr(null);
    setBusy(true);
    try {
      setPlan(
        await adminJson<RuralPlan>("/api/admin/rural", token, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ dataset: id, boxes: Math.floor(Number(boxes)), reachKm: Number(reach) || d?.reachKm || 10 }),
        }),
      );
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const served = useMemo(() => new Set(plan?.boxes.flatMap((b) => b.serves) ?? []), [plan]);
  const pins: MapPin[] = useMemo(() => {
    if (!d) return [];
    const settlements = d.settlements.map<MapPin>((s) => ({
      id: `s-${s.name}`,
      at: s.at,
      kind: "volunteer",
      tone: plan ? (served.has(s.name) ? "blue" : "grey") : "white",
      title: s.name,
      detail: `${people(s.people)} people`,
    }));
    const kits = (plan?.boxes ?? []).map<MapPin>((b, i) => ({
      id: b.id,
      at: b.hostAt,
      kind: "box",
      tone: "green",
      glyph: String(i + 1),
      title: `Box ${i + 1} · ${b.host}`,
      detail: `Serves ${people(b.people)} people · average ${b.meanKm} km, farthest ${b.worstKm} km`,
    }));
    return [...settlements, ...kits];
  }, [d, plan, served]);
  // The reach is measured along roads or paths (straight line × the road factor), so the ring is the straight-line radius.
  const rings = useMemo(() => (plan?.boxes ?? []).map((b) => ({ at: b.hostAt, radiusM: (plan!.reachKm / roadFactor) * 1000 })), [plan, roadFactor]);
  const pct = plan && plan.totalPeople ? Math.round((100 * plan.peopleWithin) / plan.totalPeople) : null;

  return (
    <div className="adm-health">
      <main id="main" className="adm-stage" aria-label="Planner map">
        {d ? <LeafletMap key={d.id} pins={pins} rings={rings} center={d.center} zoom={d.zoom} label={`Settlements and planned boxes in ${d.name}`} fill /> : <p className="muted pad">Loading…</p>}
        <div className="adm-legend">
          <span>● Settlement{plan ? " (blue = served)" : ""}</span> <span className="t-green">■ Planned box</span> <span className="t-amber">◌ Reach: {d?.reachLabel ?? ""}</span>
        </div>
      </main>
      <aside className="adm-side" aria-label="Rural planner">
        <h1 style={{ margin: 0 }}>Rural planner</h1>
        <p className="small muted" style={{ margin: 0 }}>
          Give it a place and a box budget. Each box goes to the population-weighted centre of the people nearest it, then is mounted at the closest settlement.
        </p>
        <label className="lbl" htmlFor="rural-place">
          Place
        </label>
        <select id="rural-place" className="adm-select" value={id} onChange={(e) => pick(e.target.value)}>
          {(datasets ?? []).map((x) => (
            <option key={x.id} value={x.id}>
              {x.kind} · {x.name}
            </option>
          ))}
        </select>
        {d ? (
          <p className="small muted" style={{ margin: 0 }}>
            {d.settlements.length} settlements · {people(d.settlements.reduce((a, s) => a + s.people, 0))} people
          </p>
        ) : null}
        <div style={{ display: "flex", gap: 12, alignItems: "end", flexWrap: "wrap" }}>
          <label className="small">
            Box budget
            <br />
            <input className="adm-input" type="number" min={1} max={100} value={boxes} onChange={(e) => setBoxes(e.target.value)} style={{ width: 90 }} />
          </label>
          <label className="small">
            Reach (km)
            <br />
            <input className="adm-input" type="number" min={0.1} max={200} step={0.1} value={reach} onChange={(e) => setReach(e.target.value)} style={{ width: 90 }} />
          </label>
          <button className="btn primary" aria-disabled={busy || undefined} onClick={() => void run()}>
            {busy ? "Planning…" : "Plan boxes"}
          </button>
        </div>
        {err ? (
          <p className="error" role="alert">
            {err}
          </p>
        ) : null}
        {plan ? (
          <>
            <div className="adm-tiles">
              <Tile label="Boxes" value={plan.boxes.length} />
              <Tile label="Within reach" value={`${pct}%`} tone="t-green" />
              <Tile label="People covered" value={people(plan.peopleWithin)} />
              <Tile label="Average trip" value={`${plan.meanKm} km`} />
            </div>
            <span className="lbl">Planned boxes</span>
            <ul className="adm-list">
              {plan.boxes.map((b, i) => (
                <li key={b.id} className="adm-card small">
                  <strong>
                    {i + 1}. {b.host}
                  </strong>
                  <br />
                  Serves {people(b.people)} people · average {b.meanKm} km, farthest {b.worstKm} km
                </li>
              ))}
            </ul>
            <ul className="adm-bullets small muted">
              {plan.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </>
        ) : null}
        {d ? <p className="small muted">Source: {d.source}</p> : null}
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
