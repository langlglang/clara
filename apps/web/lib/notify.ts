import type { NetworkChange, Network } from "@clara/network";
import { alertWords, inQuietHours, rideWords } from "./alertText";
import type { Ride } from "./rides";
import type { PushBook, PushPayload } from "./push";

/**
 * Sends a web push for every alert the network creates: the first wave, escalation waves and the coordinator's
 * extra alerts all show up as an `alert.update` push in state `sent` (no other path produces `sent`). Quiet hours
 * skip the push; the alert still waits in the app.
 */
export function alertPushPayload(network: Network, change: NetworkChange): { volunteerId: string; payload: PushPayload } | null {
  if (change.kind !== "push" || change.push.type !== "alert.update" || change.push.alert.state !== "sent") return null;
  const alert = change.push.alert;
  const words = alertWords(network, alert);
  if (!words) return null;
  return {
    volunteerId: alert.volunteer_id,
    payload: {
      title: words.title,
      body: words.body,
      tag: `clara-alert-${alert.alert_id}`,
      actions: true,
      data: { alert_id: alert.alert_id, volunteer_id: alert.volunteer_id, incident_id: alert.incident_id, url: `/app?alert=${encodeURIComponent(alert.alert_id)}` },
    },
  };
}

export function wireAlertPushes(network: Network, push: PushBook): () => void {
  return network.subscribe((change) => {
    const out = alertPushPayload(network, change);
    if (!out || push.devices(out.volunteerId) === 0) return;
    const volunteer = network.store.getVolunteer(out.volunteerId);
    if (!volunteer || inQuietHours(volunteer.quiet_hours, network.clock())) return;
    void push.send(out.volunteerId, out.payload);
  });
}

/** The "Send me a test alert" notification: plainly a test, no action buttons. */
export const TEST_PAYLOAD = (volunteerId: string): PushPayload => ({
  title: "CLARA TEST ALERT",
  body: "This is a test. There is no emergency. Real alerts look like this and ask if you can come.",
  tag: "clara-test",
  data: { volunteer_id: volunteerId, test: true, url: "/app" },
});

/** The push for a new ride offer to one driver, with I CAN DRIVE / CAN'T buttons. */
export function ridePushPayload(network: Network, ride: Ride, driverId: string): PushPayload | null {
  const words = rideWords(network, ride, driverId);
  if (!words) return null;
  return {
    title: words.title,
    body: words.body,
    tag: `clara-ride-${ride.ride_id}`,
    actions: true,
    data: { kind: "ride", ride_id: ride.ride_id, driver_id: driverId, incident_id: ride.incident_id, url: `/app?ride=${encodeURIComponent(ride.ride_id)}` },
  };
}

/**
 * A listener for the runtime's app changes: each ride offer (suggested driver or backup, once the dispatcher
 * approved it) gets one push to that driver's devices. Offers are told apart by driver and offered_at. `alreadyTold`
 * holds the open offers of rides restored from a snapshot, so a restart doesn't push them again.
 */
export function ridePushListener(network: Network, push: PushBook, alreadyTold: Iterable<Ride> = []): (change: { kind: string; ride?: Ride }) => void {
  const told = new Set<string>();
  for (const ride of alreadyTold) for (const f of ride.offers) told.add(`${ride.ride_id}/${f.driver_id}/${f.offered_at}`);
  return (change) => {
    if (change.kind !== "ride" || !change.ride) return;
    const ride = change.ride;
    for (const f of ride.offers) {
      if (f.state !== "offered") continue;
      const key = `${ride.ride_id}/${f.driver_id}/${f.offered_at}`;
      if (told.has(key)) continue;
      told.add(key);
      if (push.devices(f.driver_id) === 0) continue;
      const driver = network.store.getVolunteer(f.driver_id);
      if (!driver || inQuietHours(driver.quiet_hours, network.clock())) continue;
      const payload = ridePushPayload(network, ride, f.driver_id);
      if (payload) void push.send(f.driver_id, payload);
    }
  };
}
