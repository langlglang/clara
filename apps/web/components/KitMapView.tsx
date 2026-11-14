"use client";

import { useMemo, useState } from "react";
import type { KitPin } from "@clara/network";
import { BOX_STATUS, NEED_LABEL, agoWords, directionsUrl, useLive, useNow } from "../lib/client";
import type { KitMapResponse } from "../lib/views";
import { LeafletMap, type MapPin } from "./LeafletMap";
import { StatusPill } from "./TopBar";

type Tone = "red" | "amber" | "green" | "grey";

/** Status as the kit map says it: an open emergency outranks everything. */
export function pinStatus(p: KitPin): { label: string; tone: Tone } {
  if (p.open_incident_id) return { label: "Emergency here", tone: "red" };
  const s = BOX_STATUS[p.status] ?? { label: p.status, tone: "grey" as const };
  return { label: s.label, tone: s.tone === "red" ? "red" : (s.tone as Tone) };
}

/**
 * The Lime-style kit map (feature 16): every box as a pin colored by status, with the status in words, when the
 * server last heard from it, written directions and a directions link.
 */
export function KitMapView() {
  const live = useLive<KitMapResponse>("/api/kit-map");
  const now = useNow();
  const [selected, setSelected] = useState<string | null>(null);
  const data = live.data;

  const pins = useMemo<MapPin[]>(() => {
    if (!data) return [];
    const out: MapPin[] = data.pins.map((p) => {
      const s = pinStatus(p);
      return { id: p.box_id, at: p.location, kind: "box", tone: s.tone, glyph: "+", title: `${p.name}: ${s.label}`, detail: p.directions, pulse: p.status === "in_use" || !!p.open_incident_id };
    });
    for (const e of data.emergencies) out.push({ id: e.incident_id, at: e.at, kind: "emergency", tone: "red", title: `Emergency: ${NEED_LABEL[e.need] ?? e.need}`, detail: e.box_name, pulse: true });
    return out;
  }, [data]);

  return (
    <section aria-labelledby="kitmap-h" className="stack" style={{ gap: 14 }}>
      <h1 id="kitmap-h">Kit map</h1>
      <p className="muted small">
        First-aid boxes nearby. <span className="t-green">Green ready</span> · <span className="t-amber">yellow low stock</span> · <span className="t-red">orange in use or emergency</span> ·{" "}
        <span className="t-grey">grey offline</span>.
      </p>
      {live.error ? <p className="error">{live.error.message}</p> : null}
      {data ? (
        <>
          <LeafletMap pins={pins} center={data.site.center} zoom={15} tall label={`Map of first-aid boxes at ${data.site.name}`} selected={selected} onSelect={setSelected} />
          <div className="links">
            {data.pins.map((p) => {
              const s = pinStatus(p);
              return (
                <article key={p.box_id} className={`card${selected === p.box_id ? " urgent" : ""}`} aria-labelledby={`kit-${p.box_id}`}>
                  <div className="row between">
                    <h2 id={`kit-${p.box_id}`} style={{ margin: 0, fontSize: "1.1rem" }}>
                      {p.name}
                    </h2>
                    <StatusPill tone={s.tone}>{s.label}</StatusPill>
                  </div>
                  <span className="lbl">
                    Updated {agoWords(p.last_updated_at, now)}
                    {p.battery_pct !== null ? ` · battery ${Math.round(p.battery_pct)}%` : ""}
                  </span>
                  <p className="small">{p.directions}</p>
                  <div className="row">
                    <a className="btn small" href={directionsUrl(p.location.lat, p.location.lng)} target="_blank" rel="noreferrer">
                      Directions
                    </a>
                    {/* TODO: the network facade has no "grab a kit" operation yet (feature 16). Enable once it does. */}
                    <button type="button" className="btn small" disabled aria-describedby={`grab-${p.box_id}`}>
                      I&apos;m grabbing it
                    </button>
                    <span id={`grab-${p.box_id}`} className="small muted">
                      Coming soon
                    </span>
                  </div>
                </article>
              );
            })}
          </div>
          <p className="small muted">{data.site.name}. Map from OpenStreetMap.</p>
        </>
      ) : !live.error ? (
        <p className="lbl">Loading the map…</p>
      ) : null}
    </section>
  );
}
