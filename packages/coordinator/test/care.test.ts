import { describe, expect, it } from "vitest";
import { AMBULANCE_ON_SCENE_MIN, DEFAULT_CARE, DRIVER_LOAD_MIN, estimateTimeToCare, type CareDriver, type CareInput } from "../src/care.js";

const SOS = "2026-11-13T19:00:00.000Z";
const at = (min: number) => new Date(Date.parse(SOS) + min * 60_000);
const samir: CareDriver = { driver_id: "vol-samir", name: "Samir", seats: 4, pickup_minutes: 5, hospital_minutes: 13, suitable: true };
const moto: CareDriver = { driver_id: "vol-moto", name: "Moto", seats: 1, pickup_minutes: 1, hospital_minutes: 13, suitable: false };

function input(over: Partial<CareInput> = {}): CareInput {
  return {
    now: at(1),
    sos_at: SOS,
    tourniquet_at: null,
    ambulance_eta_min: 35,
    hospital: { name: "District Hospital (fictional)", drive_minutes: 13 },
    drivers: [moto, samir],
    seats_needed: 1,
    care: DEFAULT_CARE.bleeding,
    ...over,
  };
}

describe("estimateTimeToCare", () => {
  it("ambulance late (35 min demo ETA, 60 min demo deadline): the driver is faster and qualifies", () => {
    const e = estimateTimeToCare(input({ tourniquet_at: at(0.5).toISOString() }));
    expect(e.minutes_since_sos).toBe(1);
    expect(e.minutes_since_tourniquet).toBe(0.5);
    expect(e.ambulance).toMatchObject({ scene_in_min: 34, on_scene_min: AMBULANCE_ON_SCENE_MIN, drive_min: 13, hospital_in_min: 34 + AMBULANCE_ON_SCENE_MIN + 13 });
    expect(e.driver).toMatchObject({ driver_id: "vol-samir", pickup_min: 5, hospital_in_min: 5 + DRIVER_LOAD_MIN + 13 });
    expect(e.deadline).toMatchObject({ reach_hospital_within_min: 60, minutes_left: 59, demo_value: true });
    expect(e.verdict).toBe("ambulance_late_driver_faster");
    expect(e.driver_faster_by_min).toBe(39);
    expect(e.qualifies_for_request).toBe(true);
    expect(e.summary).toMatch(/simulated/);
    expect(e.notice).toMatch(/simulated/);
  });

  it("ambulance in time with a short demo ETA", () => {
    const e = estimateTimeToCare(input({ ambulance_eta_min: 10 }));
    expect(e.verdict).toBe("ambulance_in_time");
    expect(e.qualifies_for_request).toBe(false);
  });

  it("both late, still qualifies when the driver is 10+ min faster", () => {
    const e = estimateTimeToCare(input({ now: at(50) }));
    expect(e.ambulance?.scene_in_min).toBe(0);
    expect(e.verdict).toBe("both_late");
    expect(e.driver_faster_by_min).toBe(5); // 0 + 15 + 13 vs 5 + 5 + 13
    expect(e.qualifies_for_request).toBe(false);
    const far = estimateTimeToCare(input({ now: at(45), ambulance_eta_min: 70 }));
    expect(far.verdict).toBe("both_late");
    expect(far.qualifies_for_request).toBe(true);
  });

  it("needs the driver to be at least 10 min faster", () => {
    const slow = { ...samir, pickup_minutes: 30 };
    const e = estimateTimeToCare(input({ drivers: [slow], ambulance_eta_min: 40 }));
    // ambulance 39 + 15 + 13 = 67 > 59 left; driver 30 + 5 + 13 = 48 → faster by 19
    expect(e.verdict).toBe("ambulance_late_driver_faster");
    expect(e.qualifies_for_request).toBe(true);
    const slower = estimateTimeToCare(input({ drivers: [{ ...samir, pickup_minutes: 42 }], ambulance_eta_min: 40 }));
    // driver 60 vs ambulance 67: faster by 7, and over the deadline
    expect(slower.verdict).toBe("both_late");
    expect(slower.driver_faster_by_min).toBe(7);
    expect(slower.qualifies_for_request).toBe(false);
  });

  it("no suitable driver: motorbikes, too few seats, lying down needed", () => {
    expect(estimateTimeToCare(input({ drivers: [moto] })).verdict).toBe("no_driver");
    expect(estimateTimeToCare(input({ seats_needed: 5 })).verdict).toBe("no_driver");
    const lying = { ...DEFAULT_CARE.bleeding, needs_lying_down: true };
    expect(estimateTimeToCare(input({ care: lying })).verdict).toBe("no_driver");
    expect(estimateTimeToCare(input({ care: lying, drivers: [{ ...samir, carries_lying_down: true }] })).verdict).toBe("ambulance_late_driver_faster");
  });

  it("unknown without the ambulance demo setting or a hospital", () => {
    const e = estimateTimeToCare(input({ ambulance_eta_min: null }));
    expect(e.verdict).toBe("unknown");
    expect(e.ambulance).toBeNull();
    expect(e.qualifies_for_request).toBe(false);
    expect(estimateTimeToCare(input({ hospital: null })).verdict).toBe("unknown");
  });

  it("uses need-based demo defaults", () => {
    expect(DEFAULT_CARE.bleeding.reach_hospital_within_min).toBe(60);
    expect(DEFAULT_CARE.breathing.reach_hospital_within_min).toBe(30);
    expect(DEFAULT_CARE.general.reach_hospital_within_min).toBe(120);
  });
});
