import { fail, json } from "../../../../lib/http";
import { runtime } from "../../../../lib/server";

export const dynamic = "force-dynamic";

/** The EMS scene report behind a secret link. Every line cites the box events it came from. */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }): Promise<Response> {
  const { token } = await ctx.params;
  const rt = runtime();
  try {
    const report = rt.network.reportByToken(token, rt.reportOptions);
    return report ? json({ report, server_time: rt.network.clock().toISOString() }) : fail(404, "not_found", "No scene report at this link.");
  } catch (error) {
    console.error("[report] failed its check:", error);
    return fail(500, "server_error", "The scene report failed its honesty check and was withheld.");
  }
}
