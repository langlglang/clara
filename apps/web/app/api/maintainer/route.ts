import { json } from "../../../lib/http";
import { ensureRuntime } from "../../../lib/server";
import type { MaintainerResponse } from "../../../lib/views";

export const dynamic = "force-dynamic";

/** Box status, heartbeat, battery and supply counts, plus recent low-stock and offline alerts. */
export async function GET(): Promise<Response> {
  const rt = await ensureRuntime();
  const body: MaintainerResponse = {
    rows: rt.network.maintainer(),
    outreach: { push_vapid: rt.push.vapid.source, push_devices: rt.push.total(), calls_configured: rt.calls.configured, calls: rt.calls.recent(),
      demo_911: { configured: rt.demo911.configured, target: rt.demo911.target, calls: rt.demo911.log() } },
    alerts: rt.maintainerAlerts, simulated_boxes: rt.simulatedBoxes, server_time: rt.network.clock().toISOString() };
  return json(body);
}
