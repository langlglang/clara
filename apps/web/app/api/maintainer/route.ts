import { json } from "../../../lib/http";
import { runtime } from "../../../lib/server";
import type { MaintainerResponse } from "../../../lib/views";

export const dynamic = "force-dynamic";

/** Box status, heartbeat, battery and supply counts, plus recent low-stock and offline alerts. */
export async function GET(): Promise<Response> {
  const rt = runtime();
  const body: MaintainerResponse = { rows: rt.network.maintainer(), alerts: rt.maintainerAlerts, simulated_boxes: rt.simulatedBoxes, server_time: rt.network.clock().toISOString() };
  return json(body);
}
