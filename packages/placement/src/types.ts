/** Shared shapes for the kit placement planner. */

export type Fetch = (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface LatLng {
  lat: number;
  lng: number;
}

/** People on one floor, from CoStar tenancies (current tenants' employee counts split by the space they occupy). */
export interface FloorPeople {
  /** CoStar propertyFloorId (null for a floor CoStar doesn't list). */
  floorId: number | null;
  name: string;
  /** Numeric level when the floor name is a number; basements negative; null when unknown. */
  level: number | null;
  sqft: number | null;
  people: number;
  tenants: number;
}

export interface Tenant {
  name: string;
  employees: number;
  floors: string[];
  sqft: number;
}

export interface BuildingSummary {
  propertyId: number;
  name: string;
  address: string;
  city: string;
  state: string;
  location: LatLng;
  stories: number | null;
  rentableSqft: number | null;
  typicalFloorSqft: number | null;
  propertyType: string | null;
  yearBuilt: number | null;
  floors: FloorPeople[];
  topTenants: Tenant[];
  totalPeople: number;
  matterportModels: string[];
  /** Where the facts came from ("CoStar extract" or "built-in demo facts (no CoStar on this server)"). */
  source: string;
}

/** A building in the search list (from CoStar's Matterport capture list). */
export interface BuildingIndexEntry {
  propertyId: number;
  name: string;
  address: string;
  city: string;
  location: LatLng | null;
  stories: number | null;
  models: string[];
}

export interface Pano {
  id: string;
  label: string;
  x: number;
  y: number;
  z: number;
}

export interface ScanFloor {
  id: string;
  label: string;
  sequence: number;
  panos: Pano[];
}

export interface ScanModel {
  id: string;
  name: string;
  location: LatLng | null;
  floors: ScanFloor[];
  rooms: { id: string; label: string; floorId: string | null; classes: string[] }[];
}

/** Vexcel parcel and building footprint (rings are [lng, lat] pairs). */
export interface Aerial {
  parcel: [number, number][];
  footprint: [number, number][];
  footprintAreaM2: number;
  /** Highest roof point (m), when Vexcel reports it. */
  roofHeightM: number | null;
  captureDate: string | null;
  gsdM: number | null;
  /** Bounding box of the ortho image [west, south, east, north]. */
  imageBounds: [number, number, number, number];
  /** Cache file name of the ortho JPEG, when fetched. */
  imageFile: string | null;
}

export interface PickupPoint {
  id: string;
  facing: "north" | "east" | "south" | "west";
  at: LatLng;
  edgeLengthM: number;
  note: string;
}

export interface KitPlacement {
  id: string;
  level: number | null;
  floorLabel: string;
  source: "scan" | "core-rule";
  modelId: string | null;
  panoId: string | null;
  /** Scan coordinates (m, z up) for 3D tags. */
  position: { x: number; y: number; z: number } | null;
  at: LatLng;
  directions: string;
  servesLevels: number[];
  people: number;
  reason: string;
}

export interface FloorCoverage {
  level: number | null;
  label: string;
  modelId: string;
  panos: number;
  kits: number;
  coveredPct: number;
  meanS: number | null;
  maxS: number | null;
  /** Walking seconds per pano (null = unreachable / no kit), same order as the graph's nodes. */
  times: (number | null)[];
}

export interface PlanStats {
  totalPeople: number;
  peopleCovered: number;
  floorsTotal: number;
  floorsCovered: number;
  kits: number;
  scannedBefore: { coveredPct: number; maxS: number | null };
  scannedAfter: { coveredPct: number; maxS: number | null };
}

export interface Plan {
  propertyId: number;
  building: string;
  kits: KitPlacement[];
  pickups: PickupPoint[];
  coverage: FloorCoverage[];
  stats: PlanStats;
  assumptions: string[];
  reasons: string[];
  committed: boolean;
  summary: string;
}
