import { DEMO_SITE } from "@clara/network";
import { json } from "../../../lib/http";
import { runtime } from "../../../lib/server";
import { stateSnapshot } from "../../../lib/views";

export const dynamic = "force-dynamic";

/** Everything the dispatch dashboard draws: boxes, volunteers, incidents. */
export async function GET(): Promise<Response> {
  return json(stateSnapshot(runtime(), { name: DEMO_SITE.name, center: DEMO_SITE.center }));
}
