import { DEMO_SITE } from "@clara/network";
import { json } from "../../../lib/http";
import { ensureRuntime } from "../../../lib/server";
import { kitMapOf } from "../../../lib/views";

export const dynamic = "force-dynamic";

/** Kit map: box pins (ready / low / in use / offline, last update, directions), open emergencies, and helpers (rounded, unnamed). */
export async function GET(): Promise<Response> {
  return json(kitMapOf(await ensureRuntime(), { name: DEMO_SITE.name, center: DEMO_SITE.center }));
}
