import { sseResponse } from "../../../lib/http";
import { ensureRuntime } from "../../../lib/server";

export const dynamic = "force-dynamic";

/**
 * Every change for the console and the companion app, as Server-Sent Events named `change`:
 * `{ kind: "box" | "volunteer" | "event" | "incident" | "push" | "maintainer" | "ride" | "message" | "profile" | "coordinator", ... }`.
 * Pages refetch what they show when one arrives. Report tokens are left out.
 */
export async function GET(req: Request): Promise<Response> {
  const rt = await ensureRuntime();
  return sseResponse(req, (out) => {
    const offNetwork = rt.network.subscribe((change) => {
      if (change.kind === "incident") {
        const { report_token: _t, ...incident } = change.incident;
        out.send({ kind: "incident", incident }, "change");
      } else out.send(change, "change");
    });
    const offApp = rt.subscribe((change) => out.send(change, "change"));
    return () => {
      offNetwork();
      offApp();
    };
  });
}
