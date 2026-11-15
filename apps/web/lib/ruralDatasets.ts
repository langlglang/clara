import { DEMO_RURAL, type Settlement } from "@clara/placement";
import kutupalong from "./places/kutupalong-camps.json";
import perry from "./places/perry-county.json";

/**
 * Real places for the Rural planner, with their sources. Kutupalong: UNHCR population by camp and camp centroids
 * (Cox's Bazar, Bangladesh). Perry County, Pennsylvania: 2020 US Census populations of its boroughs and townships.
 * The demo county is fictional.
 */
export interface RuralDataset {
  id: "kutupalong" | "perry" | "demo";
  name: string;
  kind: string;
  source: string;
  sources: string[];
  /** Sensible starting budget and reach for this place. */
  boxes: number;
  reachKm: number;
  reachLabel: string;
  center: { lat: number; lng: number };
  zoom: number;
  settlements: Settlement[];
}

const centre = (s: Settlement[]) => ({ lat: s.reduce((a, x) => a + x.at.lat, 0) / s.length, lng: s.reduce((a, x) => a + x.at.lng, 0) / s.length });

export const RURAL_DATASETS: RuralDataset[] = [
  {
    id: "kutupalong",
    name: "Kutupalong refugee camps, Bangladesh",
    kind: "Conflict zone",
    source: kutupalong.source,
    sources: kutupalong.sources,
    boxes: 12,
    reachKm: 0.8,
    reachLabel: "a 10-minute walk",
    center: centre(kutupalong.settlements),
    zoom: 12.75,
    settlements: kutupalong.settlements,
  },
  {
    id: "perry",
    name: "Perry County, Pennsylvania",
    kind: "Rural county",
    source: perry.source,
    sources: perry.sources,
    boxes: 6,
    reachKm: 10,
    reachLabel: "10 km by road",
    center: centre(perry.settlements),
    zoom: 10,
    settlements: perry.settlements,
  },
  {
    id: "demo",
    name: "Demo county (fictional)",
    kind: "Demo",
    source: "Fictional settlements for the demo.",
    sources: [],
    boxes: 3,
    reachKm: 10,
    reachLabel: "10 km by road",
    center: centre(DEMO_RURAL),
    zoom: 10,
    settlements: DEMO_RURAL,
  },
];

export const ruralDataset = (id: unknown) => RURAL_DATASETS.find((d) => d.id === id) ?? null;
