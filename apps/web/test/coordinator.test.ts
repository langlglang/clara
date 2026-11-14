import { afterEach, describe, expect, it } from "vitest";
import { createCoordinator } from "@clara/coordinator";
import { sequentialIds } from "@clara/network";
import { POST as demoSos } from "../app/api/demo/sos/route";
import { GET as getCoordinator } from "../app/api/incidents/[id]/coordinator/route";
import { GET as getIncident } from "../app/api/incidents/[id]/route";
import { createRuntime, setRuntime, type AppChange } from "../lib/server";
import type { CoordinatorView, IncidentDetail } from "../lib/views";

const T0 = Date.parse("2026-11-13T19:00:00.000Z");
const params = (id: string) => ({ params: Promise.resolve({ id }) });

afterEach(() => setRuntime(null));

describe("coordinator in the web app", () => {
  it("is off without a key and the route says so", async () => {
    const rt = createRuntime({ clock: () => new Date(T0), ids: sequentialIds(), timers: false, env: { CLARA_MODEL: "stub" } });
    setRuntime(rt);
    expect(rt.coordinator.mode).toBe("off");
    const res = await demoSos(new Request("http://test/api/demo/sos?box=box-clinic", { method: "POST" }));
    const { incident } = (await res.json()) as { incident: { incident_id: string } };
    const view = (await (await getCoordinator(new Request("http://test"), params(incident.incident_id))).json()) as CoordinatorView;
    expect(view).toMatchObject({ mode: "off", log: null });
    expect((await getCoordinator(new Request("http://test"), params("inc_nope"))).status).toBe(404);
  });

  it("rules mode fills the log, shows it in the incident detail and streams changes", async () => {
    const rt = createRuntime({
      clock: () => new Date(T0),
      ids: sequentialIds(),
      timers: false,
      env: { CLARA_MODEL: "stub" },
      coordinator: ({ network, rides }) => createCoordinator({ network, rides, env: { CLARA_COORDINATOR: "rules" }, timers: false, debounceMs: 0, log: () => undefined }),
    });
    setRuntime(rt);
    const changes: AppChange[] = [];
    rt.subscribe((c) => changes.push(c));
    const res = await demoSos(new Request("http://test/api/demo/sos?box=box-clinic", { method: "POST" }));
    const { incident } = (await res.json()) as { incident: { incident_id: string } };
    await rt.coordinator.idle();
    const view = (await (await getCoordinator(new Request("http://test"), params(incident.incident_id))).json()) as CoordinatorView;
    expect(view.label).toBe("rules");
    expect(view.log?.plan.length).toBeGreaterThan(0);
    expect(view.log?.runs[0]?.outcome).toBe("ok");
    expect(view.log?.notes.length).toBe(1);
    const detail = (await (await getIncident(new Request("http://test"), params(incident.incident_id))).json()) as IncidentDetail;
    expect(detail.coordinator.log?.incident_id).toBe(incident.incident_id);
    expect(changes.some((c) => c.kind === "coordinator")).toBe(true);
  });

  it("rules mode with the 35 min demo ambulance requests a ride itself and offers go to drivers", async () => {
    const rt = createRuntime({
      clock: () => new Date(T0),
      ids: sequentialIds(),
      timers: false,
      env: { CLARA_MODEL: "stub", CLARA_AMBULANCE_ETA_MIN: "35" },
      coordinator: ({ network, rides, careFor, ambulanceEtaMin }) => createCoordinator({ network, rides, careFor, ambulanceEtaMin, env: { CLARA_COORDINATOR: "rules" }, timers: false, debounceMs: 0, log: () => undefined }),
    });
    setRuntime(rt);
    const res = await demoSos(new Request("http://test/api/demo/sos?box=box-clinic&need=bleeding", { method: "POST" }));
    const { incident } = (await res.json()) as { incident: { incident_id: string } };
    await rt.coordinator.idle();
    const view = (await (await getCoordinator(new Request("http://test"), params(incident.incident_id))).json()) as CoordinatorView;
    expect(view.log?.time_to_care).toMatchObject({ verdict: "ambulance_late_driver_faster", deadline: { reach_hospital_within_min: 60 } });
    expect(view.log?.ride_request?.offered_to.length).toBeGreaterThan(0);
    const ride = rt.rides.forIncident(incident.incident_id)!;
    expect(ride.state).toBe("offered");
    expect(ride.offers.every((f) => f.state === "offered")).toBe(true);
  });
});
