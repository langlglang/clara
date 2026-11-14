/**
 * Time to care: will the (simulated) ambulance get the patient to hospital within the scenario's demo deadline,
 * and would a volunteer driver be meaningfully faster? Code computes every number here; the coordinator (model or
 * rules) only reads the result. The 911 call is simulated and its ETA is a demo setting (CLARA_AMBULANCE_ETA_MIN),
 * the deadlines are fictional demo values, not medical guidance.
 */

export type Need = "bleeding" | "breathing" | "general";

export interface CareThreshold {
  reach_hospital_within_min: number;
  note: string;
  needs_lying_down?: boolean;
  needs_wheelchair?: boolean;
}

/** Used when a scenario has no `care` block. Fictional demo values, not medical guidance. */
export const DEFAULT_CARE: Record<Need, CareThreshold> = {
  bleeding: { reach_hospital_within_min: 60, note: "Default demo value for bleeding, not medical guidance." },
  breathing: { reach_hospital_within_min: 30, note: "Default demo value for breathing, not medical guidance." },
  general: { reach_hospital_within_min: 120, note: "Default demo value, not medical guidance." },
};

/** Demo assumptions: minutes the ambulance crew spends on scene before leaving, and a driver needs to load up. */
export const AMBULANCE_ON_SCENE_MIN = 15;
export const DRIVER_LOAD_MIN = 5;
/** request_ride needs a driver at least this many minutes faster than the ambulance. */
export const DRIVER_FASTER_BY_MIN = 10;

export type CareVerdict = "ambulance_in_time" | "ambulance_late_driver_faster" | "both_late" | "no_driver" | "unknown";

export interface CareDriver {
  driver_id: string;
  name: string;
  seats: number;
  pickup_minutes: number;
  /** Drive from the scene to the hospital. */
  hospital_minutes: number;
  suitable: boolean;
  carries_lying_down?: boolean;
  carries_wheelchair?: boolean;
}

export interface CareInput {
  now: Date;
  /** When the SOS opened (the incident's opened_at). */
  sos_at: string;
  /** When the tourniquet timer started, if it did. */
  tourniquet_at: string | null;
  /** Demo setting: minutes from the SOS until the simulated ambulance reaches the scene; null when not set. */
  ambulance_eta_min: number | null;
  /** Nearest demo hospital and the drive there from the scene; null when unknown. */
  hospital: { name: string; drive_minutes: number } | null;
  /** Free drivers (any order). */
  drivers: CareDriver[];
  seats_needed: number;
  care: CareThreshold;
}

export interface TimeToCare {
  verdict: CareVerdict;
  /** One line with the numbers, for notes and the console. */
  summary: string;
  minutes_since_sos: number;
  minutes_since_tourniquet: number | null;
  deadline: { reach_hospital_within_min: number; minutes_left: number; note: string; demo_value: true };
  hospital: { name: string; drive_minutes: number } | null;
  ambulance: {
    /** Minutes from now until it reaches the scene (the simulated 911 call's demo ETA, minus time elapsed). */
    scene_in_min: number;
    on_scene_min: number;
    drive_min: number;
    /** Minutes from now until the patient reaches hospital. */
    hospital_in_min: number;
    source: "CLARA_AMBULANCE_ETA_MIN demo setting (simulated 911 call)";
  } | null;
  driver: { driver_id: string; name: string; seats: number; pickup_min: number; load_min: number; drive_min: number; hospital_in_min: number } | null;
  /** Ambulance hospital time minus driver hospital time (positive: the driver is faster). */
  driver_faster_by_min: number | null;
  /** Whether request_ride may act on this estimate. */
  qualifies_for_request: boolean;
  notice: string;
}

export const CARE_NOTICE = "The 911 call is simulated: the ambulance ETA is a demo setting, not a real ETA. The deadline is a fictional demo value, not medical guidance.";

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Drivers that can take this patient: a suitable vehicle, enough seats, lying-down / wheelchair when needed. */
export function suitableDrivers(drivers: CareDriver[], seatsNeeded: number, care: CareThreshold): CareDriver[] {
  return drivers.filter((d) => d.suitable && d.seats >= seatsNeeded && (!care.needs_lying_down || d.carries_lying_down) && (!care.needs_wheelchair || d.carries_wheelchair));
}

export function estimateTimeToCare(input: CareInput): TimeToCare {
  const t = input.now.getTime();
  const sinceSos = Math.max(0, (t - Date.parse(input.sos_at)) / 60_000);
  const sinceTq = input.tourniquet_at ? Math.max(0, (t - Date.parse(input.tourniquet_at)) / 60_000) : null;
  const deadline = input.care.reach_hospital_within_min;
  const left = deadline - sinceSos;

  const ambulance =
    input.ambulance_eta_min !== null && input.hospital
      ? (() => {
          const scene = Math.max(0, input.ambulance_eta_min - sinceSos);
          return { scene_in_min: round1(scene), on_scene_min: AMBULANCE_ON_SCENE_MIN, drive_min: input.hospital.drive_minutes, hospital_in_min: round1(scene + AMBULANCE_ON_SCENE_MIN + input.hospital.drive_minutes), source: "CLARA_AMBULANCE_ETA_MIN demo setting (simulated 911 call)" as const };
        })()
      : null;

  const best = input.hospital
    ? suitableDrivers(input.drivers, input.seats_needed, input.care)
        .map((d) => ({ d, total: d.pickup_minutes + DRIVER_LOAD_MIN + d.hospital_minutes }))
        .sort((a, b) => a.total - b.total || a.d.driver_id.localeCompare(b.d.driver_id))[0]
    : undefined;
  const driver = best ? { driver_id: best.d.driver_id, name: best.d.name, seats: best.d.seats, pickup_min: best.d.pickup_minutes, load_min: DRIVER_LOAD_MIN, drive_min: best.d.hospital_minutes, hospital_in_min: best.total } : null;
  const fasterBy = ambulance && driver ? round1(ambulance.hospital_in_min - driver.hospital_in_min) : null;

  let verdict: CareVerdict;
  if (!ambulance) verdict = "unknown";
  else if (ambulance.hospital_in_min <= left) verdict = "ambulance_in_time";
  else if (!driver) verdict = "no_driver";
  else if (driver.hospital_in_min < ambulance.hospital_in_min && driver.hospital_in_min <= left) verdict = "ambulance_late_driver_faster";
  else verdict = "both_late";

  const qualifies = (verdict === "ambulance_late_driver_faster" || verdict === "both_late") && fasterBy !== null && fasterBy >= DRIVER_FASTER_BY_MIN;
  const amb = ambulance ? `ambulance (simulated) at scene ~${Math.ceil(ambulance.scene_in_min)} min, hospital ~${Math.ceil(ambulance.hospital_in_min)} min` : "ambulance ETA unknown (CLARA_AMBULANCE_ETA_MIN not set)";
  const drv = driver ? `${driver.name} pickup ~${driver.pickup_min} min, hospital ~${Math.ceil(driver.hospital_in_min)} min` : "no suitable driver";
  const words: Record<CareVerdict, string> = {
    ambulance_in_time: "ambulance in time",
    ambulance_late_driver_faster: "ambulance late, driver faster",
    both_late: "both late",
    no_driver: "ambulance late, no driver",
    unknown: "unknown",
  };
  const summary = `${words[verdict]}: ${amb}; ${drv}; deadline ${deadline} min from SOS (demo value), ${Math.max(0, Math.floor(left))} min left`;

  return {
    verdict,
    summary,
    minutes_since_sos: round1(sinceSos),
    minutes_since_tourniquet: sinceTq === null ? null : round1(sinceTq),
    deadline: { reach_hospital_within_min: deadline, minutes_left: round1(left), note: input.care.note, demo_value: true },
    hospital: input.hospital,
    ambulance,
    driver,
    driver_faster_by_min: fasterBy,
    qualifies_for_request: qualifies,
    notice: CARE_NOTICE,
  };
}
