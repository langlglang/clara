import { timingSafeEqual } from "node:crypto";
import { fail } from "./http";

/** Separate credential for Admin data and planner operations; never accepted from a URL. */
export function adminAuthorized(req: Request, configured = process.env.CLARA_ADMIN_TOKEN): boolean {
  const given = req.headers.get("x-clara-admin-token");
  if (!configured || !given || given.length > 512) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(configured);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function requireAdmin(req: Request): Response | null {
  return adminAuthorized(req) ? null : fail(403, "forbidden", "Admin access is not authorized.");
}
