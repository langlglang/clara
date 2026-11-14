import { fail, json, readJson } from "../../../../../lib/http";
import { runtime } from "../../../../../lib/server";

export const dynamic = "force-dynamic";

/** The box was refilled: counts start again from its manifest (or `{ manifest: { sku: count } }`). */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  const rt = runtime();
  const read = await readJson(req);
  if (!read.ok) return read.response;
  let manifest: Record<string, number> | undefined;
  const body = read.body as { manifest?: unknown } | undefined;
  if (body && typeof body === "object" && body.manifest !== undefined) {
    const m = body.manifest;
    const ok =
      m !== null &&
      typeof m === "object" &&
      !Array.isArray(m) &&
      Object.entries(m).every(([sku, n]) => /^[A-Za-z0-9_.:-]{1,64}$/.test(sku) && Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 999);
    if (!ok) return fail(400, "bad_request", "manifest must map sku ids to whole counts from 0 to 999.");
    manifest = m as Record<string, number>;
  }
  const ledger = rt.network.restock(id, manifest);
  if (!ledger) return fail(404, "not_found", `Unknown box "${id}".`);
  return json({ supplies: ledger });
}
