import type { LatLng } from "./types.js";

/** Local flat projection around an origin: metres east (x) and north (y). Fine at building scale. */
export function projector(origin: LatLng) {
  const kx = Math.cos((origin.lat * Math.PI) / 180) * 111_320;
  const ky = 110_540;
  return {
    toXY: (p: [number, number] | LatLng): [number, number] => {
      const [lng, lat] = Array.isArray(p) ? p : [p.lng, p.lat];
      return [(lng - origin.lng) * kx, (lat - origin.lat) * ky];
    },
    toLatLng: (x: number, y: number): LatLng => ({ lat: origin.lat + y / ky, lng: origin.lng + x / kx }),
  };
}

/** Area (m²) and centroid of a [lng, lat] ring. */
export function ringStats(ring: [number, number][]): { areaM2: number; centroid: LatLng; signedArea: number } {
  if (ring.length < 3) return { areaM2: 0, centroid: ring[0] ? { lng: ring[0][0], lat: ring[0][1] } : { lat: 0, lng: 0 }, signedArea: 0 };
  const origin = { lng: ring[0][0], lat: ring[0][1] };
  const p = projector(origin);
  const pts = ring.map((r) => p.toXY(r));
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const c = x1 * y2 - x2 * y1;
    a += c;
    cx += (x1 + x2) * c;
    cy += (y1 + y2) * c;
  }
  a /= 2;
  const centroid = a === 0 ? origin : p.toLatLng(cx / (6 * a), cy / (6 * a));
  return { areaM2: Math.abs(a), centroid, signedArea: a };
}

/** Parse a WKT POLYGON / MULTIPOLYGON into its outer rings ([lng, lat]). */
export function parseWktRings(wkt: string): [number, number][][] {
  const rings: [number, number][][] = [];
  // Every innermost "( ... )" group with no nested parens is a ring; keep the first ring of each polygon only.
  const body = wkt.replace(/^[A-Z ]+/i, "");
  let depth = 0;
  let polyStartDepth = /^MULTI/i.test(wkt.trim()) ? 2 : 1;
  let ringIndexInPoly = 0;
  let buf = "";
  for (const ch of body) {
    if (ch === "(") {
      depth++;
      if (depth === polyStartDepth) ringIndexInPoly = 0;
      buf = "";
    } else if (ch === ")") {
      if (depth === polyStartDepth + 1) {
        if (ringIndexInPoly === 0 && buf.trim()) {
          rings.push(
            buf
              .split(",")
              .map((s) => s.trim().split(/\s+/).map(Number))
              .filter((n) => n.length >= 2 && n.every(Number.isFinite))
              .map((n) => [n[0], n[1]] as [number, number]),
          );
        }
        ringIndexInPoly++;
      }
      depth--;
      buf = "";
    } else buf += ch;
  }
  return rings;
}

/** Distance (m) from a point to a segment, in local metres. */
export function pointSegmentM(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function pointInRing(x: number, y: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function bounds(ring: [number, number][]): [number, number, number, number] {
  const xs = ring.map((r) => r[0]), ys = ring.map((r) => r[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
