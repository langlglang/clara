// Adapted from Sophi (github.com/mzhao1599/sophi), apps/web/src/components/NearbyMap.tsx.
// Same approach: Leaflet loaded in an effect (never on the server), OpenStreetMap tiles with attribution, div-icon
// pins labeled for screen readers, scroll-wheel zoom off, reduced motion respected. Here the pins are boxes and
// volunteers, they update in place, and a click on the map can pick a spot (sign-up without GPS).
"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import type { LatLng } from "@clara/contracts";

const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

export interface MapPin {
  id: string;
  at: LatLng;
  kind: "box" | "volunteer" | "you" | "emergency" | "hospital";
  tone: "red" | "amber" | "green" | "grey" | "blue" | "white";
  /** Short text on the pin (one or two characters). */
  glyph?: string;
  title: string;
  detail: string;
  pulse?: boolean;
}

export interface LeafletMapProps {
  pins: readonly MapPin[];
  center: LatLng;
  zoom?: number;
  label: string;
  tall?: boolean;
  /** Fill the parent (console stage). */
  fill?: boolean;
  /** Dashed rings, e.g. the alert radius around an emergency. */
  rings?: readonly { at: LatLng; radiusM: number }[];
  /** Lines, e.g. a ride: driver to box to hospital. */
  lines?: readonly { points: readonly LatLng[]; color: string }[];
  selected?: string | null;
  onSelect?(id: string): void;
  /** When set, a click on the map picks a spot. */
  onPick?(at: LatLng): void;
}

type L = typeof import("leaflet");
const NONE: readonly never[] = [];

export function LeafletMap({ pins, center, zoom = 15, label, tall, fill, rings = NONE, lines = NONE, selected, onSelect, onPick }: LeafletMapProps) {
  const box = useRef<HTMLDivElement>(null);
  const state = useRef<{ L: L; map: import("leaflet").Map; layer: import("leaflet").LayerGroup } | null>(null);
  const handlers = useRef({ onSelect, onPick });
  handlers.current = { onSelect, onPick };

  // Create the map once.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let cancelled = false;
    let cleanup = () => {};
    void import("leaflet").then((mod) => {
      const L = (mod as unknown as { default?: L }).default ?? (mod as unknown as L);
      if (cancelled) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const map = L.map(el, { scrollWheelZoom: false, zoomSnap: 0.25, zoomAnimation: !reduce, fadeAnimation: !reduce, markerZoomAnimation: !reduce });
      L.tileLayer(TILES, { attribution: ATTRIBUTION, maxZoom: 19 }).addTo(map);
      map.setView([center.lat, center.lng], zoom);
      const layer = L.layerGroup().addTo(map);
      map.on("click", (e: import("leaflet").LeafletMouseEvent) => handlers.current.onPick?.({ lat: e.latlng.lat, lng: e.latlng.lng }));
      state.current = { L, map, layer };
      setPins.current();
      const resize = new ResizeObserver(() => map.invalidateSize());
      resize.observe(el);
      cleanup = () => {
        resize.disconnect();
        map.remove();
        state.current = null;
      };
    });
    return () => {
      cancelled = true;
      cleanup();
    };
    // The map is created once; pins and center changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Redraw pins whenever they change.
  const setPins = useRef(() => {});
  setPins.current = () => {
    const s = state.current;
    if (!s) return;
    const { L, layer } = s;
    layer.clearLayers();
    for (const r of rings) L.circle([r.at.lat, r.at.lng], { radius: r.radiusM, color: "#F97316", opacity: 0.5, weight: 2, dashArray: "6 8", fill: false, interactive: false }).addTo(layer);
    for (const l of lines) L.polyline(l.points.map((x) => [x.lat, x.lng] as [number, number]), { color: l.color, weight: 5, opacity: 0.9, interactive: false }).addTo(layer);
    for (const p of pins) {
      const html = `<span class="pin" data-kind="${p.kind}" data-tone="${p.tone}" data-pulse="${p.pulse ? "true" : "false"}" data-selected="${selected === p.id}">${escapeHtml(p.glyph ?? "")}</span>`;
      const size = p.kind === "emergency" ? 32 : p.kind === "box" || p.kind === "hospital" ? 28 : 20;
      const marker = L.marker([p.at.lat, p.at.lng], {
        icon: L.divIcon({ html, className: "pin-box", iconSize: [size, size], iconAnchor: [size / 2, size / 2] }),
        title: p.title,
        keyboard: true,
        zIndexOffset: p.kind === "emergency" ? 900 : p.kind === "box" ? 500 : 0,
      });
      const div = document.createElement("div");
      const strong = document.createElement("strong");
      strong.textContent = p.title;
      div.append(strong, document.createElement("br"), p.detail);
      marker.bindPopup(div);
      marker.on("add", () => marker.getElement()?.setAttribute("aria-label", `${p.title}. ${p.detail}`));
      marker.on("click", () => handlers.current.onSelect?.(p.id));
      marker.addTo(layer);
    }
  };
  useEffect(() => {
    setPins.current();
  }, [pins, selected, rings, lines]);

  useEffect(() => {
    state.current?.map.setView([center.lat, center.lng], state.current.map.getZoom() || zoom);
  }, [center.lat, center.lng, zoom]);

  return <div ref={box} className={`map${tall ? " tall" : ""}${fill ? " fill" : ""}`} role="region" aria-label={label} />;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
