import { fail, json, readJson } from "../../../../lib/http";
import { admin, startPlan } from "../../../../lib/admin";
import { requireAdmin } from "../../../../lib/admin-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Start a planning run (the agent, or the deterministic planner without a model key). Poll GET ?id= for progress. */
export async function POST(req: Request): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const body = await readJson(req);
  if (!body.ok) return body.response;
  const { propertyId: id, maxKits } = (body.body ?? {}) as { propertyId?: unknown; maxKits?: unknown };
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return fail(400, "bad_request", "propertyId is required.");
  if (maxKits != null && (typeof maxKits !== "number" || !Number.isInteger(maxKits) || maxKits < 1 || maxKits > 200)) return fail(400, "bad_request", "maxKits must be a whole number from 1 to 200.");
  const job = startPlan(id, maxKits ?? undefined);
  return job ? json(job, 202) : fail(429, "conflict", "Two plans are already running. Please try again shortly.");
}

export async function GET(req: Request): Promise<Response> {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const id = new URL(req.url).searchParams.get("id") ?? "";
  const job = admin().jobs.get(id);
  return job ? json(job) : fail(404, "not_found", "No such planning run.");
}
