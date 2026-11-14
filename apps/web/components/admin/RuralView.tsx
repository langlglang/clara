"use client";

import { useState } from "react";
import type { RuralPlan } from "@clara/placement";
import { adminJson } from "./api";

/** Rural planner: K boxes placed at population-weighted centres of a county's settlements (demo county). */
export function RuralView({ token }: { token: string }) {
  const [boxes, setBoxes] = useState("3");
  const [reach, setReach] = useState("10");
  const [plan, setPlan] = useState<RuralPlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const run = async () => {
    setErr(null);
    try {
      setPlan(await adminJson<RuralPlan>("/api/admin/rural", token, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ boxes: Math.floor(Number(boxes)), reachKm: Number(reach) || 10 }) }));
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <main id="main" className="page stack" style={{ maxWidth: 760, margin: "1.5rem auto" }}>
      <h1>Rural planner</h1>
      <p className="small muted">Demo county (fictional settlements). Each box goes to the population-weighted centre of the people nearest it, then is mounted at the closest settlement.</p>
      <div style={{ display: "flex", gap: 16, alignItems: "end", flexWrap: "wrap" }}>
        <label className="small">Boxes<br /><input className="adm-input" type="number" min={1} max={100} value={boxes} onChange={(e) => setBoxes(e.target.value)} style={{ width: 90 }} /></label>
        <label className="small">Reach (km by road)<br /><input className="adm-input" type="number" min={1} max={200} value={reach} onChange={(e) => setReach(e.target.value)} style={{ width: 90 }} /></label>
        <button className="btn primary" onClick={() => void run()}>Plan boxes</button>
      </div>
      {err ? <p className="error" role="alert">{err}</p> : null}
      {plan ? (
        <>
          <p><strong>{plan.peopleWithin.toLocaleString()}</strong> of {plan.totalPeople.toLocaleString()} people within {plan.reachKm} km of a box · average trip {plan.meanKm} km</p>
          <ul className="adm-bullets">
            {plan.boxes.map((b) => (
              <li key={b.id}>
                <strong>{b.host}</strong> — serves {b.people.toLocaleString()} people ({b.serves.join(", ")}); average {b.meanKm} km, farthest {b.worstKm} km. Weighted centre is {b.hostOffsetKm} km from {b.host} ({b.centre.lat.toFixed(4)}, {b.centre.lng.toFixed(4)}).
              </li>
            ))}
          </ul>
          <ul className="adm-bullets small muted">{plan.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </>
      ) : null}
    </main>
  );
}
