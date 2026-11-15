"use client";

import { useMemo } from "react";
import type { LatLng } from "@clara/contracts";
import { NEED_LABEL, SKILL_LABEL } from "../../lib/client";
import type { RideView } from "../../lib/rides";
import type { StateSnapshot } from "../../lib/views";
import { LeafletMap, type MapPin } from "../LeafletMap";
import { pinStatus } from "../KitMapView";

/**
 * The console's always-on live map: every helper (on foot blue, drivers white, unavailable grey), every box by
 * status, open emergencies pulsing with a dashed 1 km ring (nearby boxes light up inside it), the hospital, and the
 * selected ride's route.
 */
export function ConsoleMap({
  state,
  selectedIncident,
  ride,
  onSelectIncident,
}: {
  state: StateSnapshot;
  selectedIncident?: string | null;
  ride?: RideView | null;
  onSelectIncident?(id: string): void;
}) {
  const pins = useMemo<MapPin[]>(() => {
    const out: MapPin[] = [];
    for (const v of state.volunteers) {
      const driver = v.vehicle_seats > 0;
      const extras = [v.carries_lying_down ? "can take someone lying down" : null, v.carries_wheelchair ? "wheelchair" : null, v.usual_availability ?? null].filter(Boolean).join(" · ");
      out.push({
        id: v.volunteer_id,
        at: v.location,
        // Drivers (including home drivers with no first-aid skill) get a square car marker showing their free seats.
        kind: driver ? "driver" : "volunteer",
        ...(driver ? { glyph: String(v.vehicle_seats) } : {}),
        tone: !v.available ? "grey" : driver ? "white" : "blue",
        title: `${v.name}${v.available ? "" : " (unavailable)"}`,
        detail: `${v.skills.map((s) => SKILL_LABEL[s] ?? s).join(", ")}${driver ? ` · ${state.vehicles[v.volunteer_id] ?? "vehicle"}, ${v.vehicle_seats} seats` : " · on foot"}${extras ? ` · ${extras}` : ""}`,
      });
    }
    for (const b of state.boxes) {
      const s = pinStatus(b);
      out.push({ id: b.box_id, at: b.location, kind: "box", tone: s.tone, glyph: "+", title: `${b.name}: ${s.label}`, detail: b.directions });
    }
    for (const i of state.incidents) {
      if (i.incident.closed || !i.box) continue;
      out.push({
        id: i.incident.incident_id,
        at: i.box.location,
        kind: "emergency",
        tone: "red",
        title: `Emergency: ${NEED_LABEL[i.incident.need] ?? i.incident.need} at ${i.box.name}`,
        detail: i.coming_line ?? "Nobody has accepted yet.",
        pulse: true,
      });
    }
    out.push({ id: "hospital", at: state.hospital.location, kind: "hospital", tone: "white", glyph: "H", title: state.hospital.name, detail: "Hospital" });
    if (ride && ride.hospital.name !== state.hospital.name)
      out.push({ id: "ride-hospital", at: ride.hospital.location, kind: "hospital", tone: "white", glyph: "H", title: ride.hospital.name, detail: "Ride destination" });
    return out;
  }, [state, ride]);

  const rings = useMemo(
    () => state.incidents.filter((i) => !i.incident.closed && i.box).map((i) => ({ at: i.box!.location, radiusM: 1000 })),
    [state],
  );

  const lines = useMemo(() => {
    if (!ride) return [];
    const box = state.boxes.find((b) => b.box_id === ride.box_id);
    const driverId = ride.winner?.driver_id ?? ride.offers.find((f) => f.state === "offered")?.driver_id ?? ride.suggested?.driver_id;
    const driver = state.volunteers.find((v) => v.volunteer_id === driverId);
    if (!box) return [];
    const points: LatLng[] = [...(driver ? [driver.location] : []), box.location, ride.hospital.location];
    return [{ points, color: "#2563EB" }];
  }, [ride, state]);

  return (
    <LeafletMap
      fill
      pins={pins}
      rings={rings}
      lines={lines}
      center={state.site.center}
      zoom={15}
      selected={selectedIncident ?? null}
      onSelect={(id) => {
        if (state.incidents.some((i) => i.incident.incident_id === id)) onSelectIncident?.(id);
      }}
      label={`Live map of helpers, boxes and emergencies at ${state.site.name}`}
    />
  );
}

export function MapLegend() {
  return (
    <div className="legend" aria-label="Map legend">
      <span className="t-green">■ Ready</span>
      <span className="t-amber">■ Low stock</span>
      <span className="t-red">● Emergency / in use</span>
      <span className="t-blue">● Helper on foot</span>
      <span>■ Driver (seats)</span>
      <span className="t-grey">■ Offline</span>
    </div>
  );
}

export function helperCounts(state: StateSnapshot) {
  const available = state.volunteers.filter((v) => v.available);
  const drivers = available.filter((v) => v.vehicle_seats > 0).length;
  return { available: available.length, drivers, onFoot: available.length - drivers };
}
