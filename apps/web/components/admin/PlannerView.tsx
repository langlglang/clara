"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Aerial, BuildingIndexEntry, BuildingSummary, FloorCoverage, KitPlacement, PickupPoint, ScanInfo } from "@clara/placement";
import type { PlanJob } from "../../lib/admin";
import { MatterportTour } from "./MatterportTour";

/** Shapes of the admin API answers (kept local: the routes return plain JSON). */
interface GraphView {
  modelId: string;
  modelName: string;
  level: number | null;
  label: string;
  nodes: { id: string; label: string; x: number; y: number; z: number }[];
  edges: [number, number][];
  extent: { minX: number; minY: number; maxX: number; maxY: number };
}
interface BuildingResponse {
  building: BuildingSummary;
  scans: ScanInfo[];
  warnings: string[];
  aerial: (Omit<Aerial, "imageFile"> & { hasImage: boolean }) | null;
  pickups: PickupPoint[];
  graphs: GraphView[];
}
interface Status {
  costar: boolean;
  matterport: boolean;
  vexcel: boolean;
  agent: boolean;
  mp_sdk_key: string | null;
}

const DEFAULT_ID = 233899;

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { cache: "no-store", ...init });
  const body = (await r.json().catch(() => null)) as T & { error?: { message?: string } };
  if (!r.ok) throw new Error(body?.error?.message ?? `HTTP ${r.status}`);
  return body;
}

export function PlannerView({ onDeployed }: { onDeployed(): void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [q, setQ] = useState("");
  const [list, setList] = useState<BuildingIndexEntry[]>([]);
  const [id, setId] = useState(DEFAULT_ID);
  const [b, setB] = useState<BuildingResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [level, setLevel] = useState<number | null>(null);
  const [job, setJob] = useState<PlanJob | null>(null);
  const [deployMsg, setDeployMsg] = useState<string | null>(null);

  useEffect(() => {
    void getJson<Status>("/api/admin/status").then(setStatus).catch(() => setStatus(null));
  }, []);

  const search = useCallback((text: string) => {
    void getJson<{ buildings: BuildingIndexEntry[] }>(`/api/admin/buildings?q=${encodeURIComponent(text)}`)
      .then((r) => setList(r.buildings))
      .catch(() => setList([]));
  }, []);
  useEffect(() => search(""), [search]);

  useEffect(() => {
    setB(null);
    setLoadErr(null);
    setJob(null);
    setDeployMsg(null);
    void getJson<BuildingResponse>(`/api/admin/building?id=${id}`)
      .then((r) => {
        setB(r);
        setLevel(r.graphs.find((g) => g.level === 53)?.level ?? r.graphs[0]?.level ?? null);
      })
      .catch((e: Error) => setLoadErr(e.message));
  }, [id]);

  // Poll the planning run while it works.
  useEffect(() => {
    if (!job || job.status === "done" || job.status === "failed") return;
    const t = setTimeout(() => void getJson<PlanJob>(`/api/admin/plan?id=${job.id}`).then(setJob).catch(() => {}), 700);
    return () => clearTimeout(t);
  }, [job]);

  const run = async () => {
    setDeployMsg(null);
    setJob(await getJson<PlanJob>("/api/admin/plan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyId: id }) }));
  };
  const deploy = async () => {
    if (!job) return;
    try {
      const r = await getJson<{ deployed: number }>("/api/admin/deploy", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: job.id }) });
      setDeployMsg(`Deployed ${r.deployed} kits to the Clara network.`);
      setJob(await getJson<PlanJob>(`/api/admin/plan?id=${job.id}`));
    } catch (e) {
      setDeployMsg((e as Error).message);
    }
  };

  const plan = job?.plan ?? null;
  const graph = b?.graphs.find((g) => g.level === level) ?? null;
  const cov = plan?.coverage.find((c) => c.modelId === graph?.modelId) ?? null;
  const floorKits = plan?.kits.filter((k) => k.modelId && k.modelId === graph?.modelId) ?? [];

  return (
    <div className="adm-planner">
      {/* Left: building */}
      <section className="adm-col" aria-label="Building">
        {status && !status.costar ? <p className="adm-warn">CoStar extract not available on this server: building list and people per floor are limited to the built-in demo facts.</p> : null}
        <form
          className="adm-search"
          onSubmit={(e) => {
            e.preventDefault();
            search(q);
          }}
        >
          <input className="adm-input" placeholder="Search CoStar buildings" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search buildings" />
          <button className="btn small">Search</button>
        </form>
        <select className="adm-select" value={id} onChange={(e) => setId(Number(e.target.value))} aria-label="Building">
          {!list.some((x) => x.propertyId === id) ? <option value={id}>Property {id}</option> : null}
          {list.map((x) => (
            <option key={x.propertyId} value={x.propertyId}>
              {x.name} · {x.city} · {x.stories ?? "?"} fl · {x.models.length} scan{x.models.length === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        {loadErr ? <p className="error">{loadErr}</p> : null}
        {!b && !loadErr ? <p className="muted small">Loading CoStar, Matterport and Vexcel data… (first load of a building reads the extract and calls the APIs; later loads come from the cache)</p> : null}
        {b ? <BuildingFacts b={b} plan={plan?.kits ?? []} level={level} setLevel={setLevel} /> : null}
      </section>

      {/* Middle: spatial views */}
      <section className="adm-col adm-mid" aria-label="Floor and site">
        {b ? (
          <>
            <div className="adm-card">
              <div className="adm-head">
                <span className="lbl">Floor walking graph · Matterport</span>
                <span className="adm-levels">
                  {b.graphs.map((g) => (
                    <button key={g.modelId} className={g.level === level ? "on" : ""} onClick={() => setLevel(g.level)}>
                      L{g.level}
                    </button>
                  ))}
                </span>
              </div>
              {graph ? <FloorGraphSvg g={graph} cov={cov} kits={floorKits} /> : <p className="muted small">No whole-floor scans for this building{status && !status.matterport ? " (Matterport keys not set)" : ""}.</p>}
              {graph ? (
                <p className="small mono">
                  {graph.modelName} · {graph.nodes.length} scan points · {graph.edges.length} links
                  {cov ? ` · ${cov.kits} kit${cov.kits === 1 ? "" : "s"} · ${cov.coveredPct}% within 90 s · worst ${cov.maxS ?? "–"} s · mean ${cov.meanS ?? "–"} s` : " · no kits yet"}
                </p>
              ) : null}
              <HeatLegend />
            </div>
            <div className="adm-card">
              <span className="lbl">3D tour · Matterport Showcase</span>
              {graph ? <MatterportTour modelId={graph.modelId} sdkKey={status?.mp_sdk_key ?? null} kits={floorKits} /> : <p className="muted small">Pick a scanned floor.</p>}
            </div>
            <div className="adm-card">
              <span className="lbl">Site · Vexcel aerial</span>
              {b.aerial ? <AerialSvg id={b.building.propertyId} aerial={b.aerial} pickups={plan?.pickups.length ? plan.pickups : b.pickups} chosen={!!plan} kits={plan?.kits ?? []} /> : <p className="muted small">No Vexcel data{status && !status.vexcel ? " (VEXCEL_API_KEY not set)" : ""}.</p>}
              {b.aerial ? (
                <p className="small mono">
                  Footprint {b.aerial.footprintAreaM2.toLocaleString()} m² · capture {b.aerial.captureDate?.slice(0, 10) ?? "?"} · {b.aerial.gsdM ? `${Math.round(b.aerial.gsdM * 100)} cm/px` : ""} · {plan ? "pickups chosen by the planner" : "street-facing pickup candidates"}
                </p>
              ) : null}
            </div>
          </>
        ) : null}
      </section>

      {/* Right: agent */}
      <section className="adm-col" aria-label="Planner agent">
        <span className="lbl">Planner · {status ? (status.agent ? "deep agent (Claude)" : "deterministic (no model key)") : "…"}</span>
        <p className="small muted">
          Sources: CoStar {status?.costar ? "✓" : "✗"} · Matterport {status?.matterport ? "✓" : "✗"} · Vexcel {status?.vexcel ? "✓" : "✗"}
        </p>
        <button className="btn" onClick={run} disabled={!b || (job != null && job.status !== "done" && job.status !== "failed")}>
          {job && (job.status === "loading" || job.status === "planning") ? "Planning…" : plan ? "Re-plan" : "Plan kits"}
        </button>
        {job ? <AgentLog job={job} /> : <p className="small muted">The planner reads the building (CoStar), walks every scanned floor (Matterport), checks the site (Vexcel), proposes kits, evaluates coverage, revises, and commits a plan. It can act only through its tools.</p>}
        {plan ? (
          <>
            <div className="adm-tiles">
              <Stat label="Kits" value={plan.stats.kits} />
              <Stat label="People covered" value={`${plan.stats.peopleCovered.toLocaleString()}/${plan.stats.totalPeople.toLocaleString()}`} />
              <Stat label="Floors covered" value={`${plan.stats.floorsCovered}/${plan.stats.floorsTotal}`} />
              <Stat label="Scanned ≤ 90 s" value={`${plan.stats.scannedBefore.coveredPct}% → ${plan.stats.scannedAfter.coveredPct}%`} />
            </div>
            {plan.summary ? <p className="small">{plan.summary}</p> : null}
            {plan.reasons.length ? (
              <>
                <span className="lbl">Reasons</span>
                <ul className="adm-bullets small">
                  {plan.reasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <button className="btn primary" onClick={deploy} disabled={!plan.committed || !!job?.deployed}>
              {job?.deployed ? `Deployed ${job.deployed.box_ids.length} kits` : "Deploy kits"}
            </button>
            {deployMsg ? (
              <p className="small">
                {deployMsg}{" "}
                {job?.deployed ? (
                  <button className="btn small ghost" onClick={onDeployed}>
                    See them on the map
                  </button>
                ) : null}
              </p>
            ) : null}
            <span className="lbl">Kits ({plan.kits.length})</span>
            <ol className="adm-kits small">
              {plan.kits.map((k) => (
                <li key={k.id} className={k.modelId === graph?.modelId ? "on" : undefined}>
                  <b className="mono">{k.level == null ? "?" : `L${k.level}`}</b> {k.directions} <span className="muted">{k.people ? `${k.people} people. ` : ""}{k.reason}</span>
                </li>
              ))}
            </ol>
            <span className="lbl">Assumptions</span>
            <ul className="adm-bullets small muted">
              {plan.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="adm-tile">
      <span className="lbl">{label}</span>
      <b className="big mono">{value}</b>
    </div>
  );
}

function BuildingFacts({ b, plan, level, setLevel }: { b: BuildingResponse; plan: KitPlacement[]; level: number | null; setLevel(l: number): void }) {
  const s = b.building;
  const scanned = new Set(b.graphs.map((g) => g.level));
  const floors = s.floors.filter((f) => f.level != null && f.level > 0).sort((x, y) => (y.level ?? 0) - (x.level ?? 0));
  const max = Math.max(1, ...floors.map((f) => f.people));
  const kitLevels = new Set(plan.map((k) => k.level));
  return (
    <>
      <div className="adm-card">
        <span className="lbl">CoStar · {s.propertyType ?? "property"} {s.propertyId}</span>
        <h2>{s.name}</h2>
        <p className="small">
          {s.address}, {s.city} {s.state}
          {s.yearBuilt ? ` · built ${s.yearBuilt}` : ""}
        </p>
        <div className="adm-tiles">
          <Stat label="Stories" value={s.stories ?? "–"} />
          <Stat label="People (CoStar)" value={s.totalPeople ? s.totalPeople.toLocaleString() : "–"} />
          <Stat label="Rentable ft²" value={s.rentableSqft ? `${Math.round(s.rentableSqft / 1000).toLocaleString()}k` : "–"} />
          <Stat label="Floor scans" value={b.graphs.length} />
        </div>
        {b.warnings.map((w) => (
          <p key={w} className="adm-warn small">
            {w}
          </p>
        ))}
      </div>
      <div className="adm-card">
        <span className="lbl">People per floor · section view</span>
        <div className="adm-section" role="list" aria-label="People per floor">
          {floors.map((f) => (
            <button
              key={`${f.level}-${f.floorId}`}
              role="listitem"
              className={`adm-floor${scanned.has(f.level) ? " scanned" : ""}${f.level === level ? " on" : ""}`}
              onClick={() => scanned.has(f.level) && setLevel(f.level!)}
              title={`Level ${f.level}: ${f.people} people, ${f.tenants} tenant spaces${scanned.has(f.level) ? ", Matterport scan" : ""}${kitLevels.has(f.level) ? ", kit planned" : ""}`}
            >
              <span className="mono">{f.level}</span>
              <span className="bar" style={{ width: `${(100 * f.people) / max}%` }} />
              {kitLevels.has(f.level) ? <span className="kit">■</span> : null}
            </button>
          ))}
        </div>
        <p className="small muted">Bar = people; blue = scanned floor (click to view); ■ = kit planned.</p>
      </div>
      {s.topTenants.length ? (
        <div className="adm-card">
          <span className="lbl">Top tenants</span>
          <ul className="adm-tenants small">
            {s.topTenants.slice(0, 8).map((t) => (
              <li key={t.name}>
                <span>{t.name}</span>
                <span className="mono muted">
                  {t.employees} · {t.floors.slice(0, 4).join(", ")}
                  {t.floors.length > 4 ? "…" : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="adm-card">
        <span className="lbl">Matterport scans</span>
        <ul className="adm-tenants small">
          {b.scans.map((x, i) => (
            <li key={`${x.modelId}-${i}`}>
              <span>{x.name}</span>
              <span className="mono muted">
                {x.level != null ? `L${x.level} · ` : ""}
                {x.points} pts · {x.note}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

const heat = (t: number | null | undefined) => (t == null ? "#52525B" : t <= 30 ? "#22C55E" : t <= 60 ? "#EAB308" : t <= 90 ? "#F97316" : "#EF4444");

function HeatLegend() {
  return (
    <p className="small mono adm-heat">
      Walk to nearest kit: <i style={{ background: heat(10) }} /> ≤30 s <i style={{ background: heat(45) }} /> ≤60 s <i style={{ background: heat(80) }} /> ≤90 s <i style={{ background: heat(120) }} /> &gt;90 s <i style={{ background: heat(null) }} /> no kit
    </p>
  );
}

function FloorGraphSvg({ g, cov, kits }: { g: GraphView; cov: FloorCoverage | null; kits: KitPlacement[] }) {
  const pad = 2;
  const w = g.extent.maxX - g.extent.minX + pad * 2, h = g.extent.maxY - g.extent.minY + pad * 2;
  // y is north-up in scan space; flip for SVG.
  const X = (x: number) => x - g.extent.minX + pad;
  const Y = (y: number) => g.extent.maxY - y + pad;
  const r = Math.max(w, h) / 120;
  return (
    <svg className="adm-graph" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Walking graph of ${g.label}`}>
      {g.edges.map(([i, j], k) => (
        <line key={k} x1={X(g.nodes[i].x)} y1={Y(g.nodes[i].y)} x2={X(g.nodes[j].x)} y2={Y(g.nodes[j].y)} stroke="#3F3F46" strokeWidth={r / 2} />
      ))}
      {g.nodes.map((n, i) => (
        <circle key={n.id} cx={X(n.x)} cy={Y(n.y)} r={r * 1.4} fill={heat(cov?.times[i])}>
          <title>{`Scan point ${n.label}: ${cov?.times[i] == null ? "no kit" : `${cov.times[i]} s to a kit`}`}</title>
        </circle>
      ))}
      {kits.map((k) =>
        k.position ? (
          <g key={k.id}>
            <rect x={X(k.position.x) - r * 3} y={Y(k.position.y) - r * 3} width={r * 6} height={r * 6} fill="#F97316" stroke="#18181B" strokeWidth={r / 2} />
            <text x={X(k.position.x)} y={Y(k.position.y) + r * 1.4} fontSize={r * 4} textAnchor="middle" fill="#18181B" fontFamily="IBM Plex Mono" fontWeight={700}>
              +
            </text>
          </g>
        ) : null,
      )}
    </svg>
  );
}

function AerialSvg({ id, aerial, pickups, chosen, kits }: { id: number; aerial: BuildingResponse["aerial"] & object; pickups: PickupPoint[]; chosen: boolean; kits: KitPlacement[] }) {
  const [w, s, e, n] = aerial.imageBounds;
  const aspect = ((n - s) * 110_540) / ((e - w) * Math.cos((((n + s) / 2) * Math.PI) / 180) * 111_320);
  const W = 1000, H = Math.round(W * aspect);
  const P = (lng: number, lat: number) => `${((lng - w) / (e - w)) * W},${((n - lat) / (n - s)) * H}`;
  const ring = (r: [number, number][]) => r.map(([lng, lat]) => P(lng, lat)).join(" ");
  const pts = useMemo(() => kits.map((k) => P(k.at.lng, k.at.lat).split(",").map(Number)), [kits]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <svg className="adm-aerial" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Aerial image with the building footprint and pickup points">
      {aerial.hasImage ? <image href={`/api/admin/aerial?id=${id}`} x={0} y={0} width={W} height={H} preserveAspectRatio="none" /> : <rect width={W} height={H} fill="#1F1F23" />}
      <polygon points={ring(aerial.parcel)} fill="none" stroke="#A1A1AA" strokeDasharray="8 8" strokeWidth={3} />
      <polygon points={ring(aerial.footprint)} fill="rgba(249,115,22,0.15)" stroke="#F97316" strokeWidth={4} />
      {pts.map(([x, y], i) => (
        <rect key={i} x={x - 5} y={y - 5} width={10} height={10} fill="#F97316" stroke="#18181B" strokeWidth={2} />
      ))}
      {pickups.map((p) => {
        const [x, y] = P(p.at.lng, p.at.lat).split(",").map(Number);
        return (
          <g key={p.id}>
            <circle cx={x} cy={y} r={22} fill={chosen ? "#38BDF8" : "rgba(56,189,248,0.4)"} stroke="#18181B" strokeWidth={4} />
            <text x={x} y={y + 9} textAnchor="middle" fontSize={26} fontWeight={700} fontFamily="IBM Plex Mono" fill="#18181B">
              P
            </text>
            <title>{p.note}</title>
          </g>
        );
      })}
    </svg>
  );
}

function AgentLog({ job }: { job: PlanJob }) {
  const items = [...job.thoughts.map((t) => ({ at: t.at, kind: "note" as const, text: t.text })), ...job.log.map((l) => ({ at: l.at, kind: l.ok ? ("tool" as const) : ("refused" as const), text: `${l.tool}(${l.args === "{}" ? "" : l.args}) → ${l.result}` }))].sort((a, b) => a.at.localeCompare(b.at));
  return (
    <div className="adm-log" aria-live="polite">
      <span className="lbl">
        Run · {job.status}
        {job.mode ? ` · ${job.mode === "agent" ? "deep agent" : "deterministic planner"}` : ""}
      </span>
      {job.error ? <p className="small t-amber">{job.error}</p> : null}
      <ol>
        {items.map((it, i) => (
          <li key={i} className={it.kind}>
            <span className="mono muted">{it.at.slice(11, 19)}</span> {it.text}
          </li>
        ))}
      </ol>
    </div>
  );
}
