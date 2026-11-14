import { fail, json, readJson } from "../../../../lib/http";
import { ensureRuntime } from "../../../../lib/server";
import { admin, deployPlan } from "../../../../lib/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Deploy a committed plan: its kits become Clara boxes (with directions) on the network. */
export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  if (!body.ok) return body.response;
  const jobId = (body.body as { jobId?: unknown } | undefined)?.jobId;
  if (typeof jobId !== "string" || !jobId) return fail(400, "bad_request", "jobId is required.");
  const job = admin().jobs.get(jobId);
  if (!job?.plan?.committed) return fail(409, "conflict", "That run has no committed plan yet.");
  const ids = deployPlan(await ensureRuntime(), job);
  return json({ deployed: ids.length, box_ids: ids });
}
