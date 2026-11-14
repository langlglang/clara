import { json } from "../../../../lib/http";
import { admin } from "../../../../lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Which planner data sources this server has, and the Matterport Showcase SDK key (designed for browser use). */
export async function GET(): Promise<Response> {
  const s = admin().placement.status();
  return json({ ...s, mp_sdk_key: process.env.MP_SDK_KEY?.trim() || null });
}
