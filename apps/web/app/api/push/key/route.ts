import { json } from "../../../../lib/http";
import { runtime } from "../../../../lib/server";

export const dynamic = "force-dynamic";

/** The VAPID public key the browser subscribes with (from VAPID_PUBLIC_KEY, or generated at server start). */
export async function GET(): Promise<Response> {
  const { vapid } = runtime().push;
  return json({ publicKey: vapid.publicKey, source: vapid.source });
}
