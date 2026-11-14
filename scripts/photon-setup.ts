/**
 * One-time Photon (photon.codes, Beta / 2.0 API) setup for Clara's text alerts. Run it yourself, in your own terminal:
 *
 *   PHOTON_API_KEY=pho_sk_... PHOTON_PROJECT_ID=pho_prj_01m7cbytt4fahstv8xerqw8w8z npx tsx scripts/photon-setup.ts [--assign +15551234567] [--webhook]
 *
 * Always: checks the key (GET /platforms/imessage) and lists the project's shared iMessage line assignments.
 * --assign <E.164>: assigns a shared iMessage line to that volunteer phone (uses a seat) and prints the Clara number
 *   they must text once ("hi") before Clara can text them (a shared line can't send the first message).
 * --webhook: registers https://clara.living/api/photon/webhook (or --url) for message.received and prints the
 *   signing secret ONCE to this terminal; copy it into Render as PHOTON_WEBHOOK_SECRET. Nothing is written to disk.
 */
import { randomUUID } from "node:crypto";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : "") : null;
};
const key = process.env.PHOTON_API_KEY?.trim();
const project = process.env.PHOTON_PROJECT_ID?.trim();
if (!key || !project) {
  console.error("Set PHOTON_API_KEY and PHOTON_PROJECT_ID (copy the pho_prj_ id from app.beta.photon.codes; the key can't look it up).");
  process.exit(1);
}
const base = `${(process.env.PHOTON_BASE_URL?.trim() || "https://api.photon.codes").replace(/\/+$/, "")}/v1/projects/${encodeURIComponent(project)}`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { authorization: `Bearer ${key}`, accept: "application/json" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = `clara-setup-${randomUUID()}`;
  }
  const res = await fetch(`${base}${path}`, { method, headers, signal: AbortSignal.timeout(15_000), ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const json = (await res.json().catch(() => null)) as (T & { title?: string; detail?: string; code?: string }) | null;
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.code ?? ""} ${json?.title ?? ""} ${json?.detail ?? ""}`.trim());
  return json as T;
}

const imessage = await call<Record<string, unknown>>("GET", "/platforms/imessage");
console.log("Key works. iMessage mode:", JSON.stringify(imessage));

const list = await call<{ assignments: Array<{ assignmentId: string; handle: string; assignedPhoneNumber: string; releasedAt?: string }> }>("GET", "/platforms/imessage/assignments?pageSize=200");
const mask = (p: string) => (p.length <= 6 ? "***" : `${p.slice(0, 2)}${"*".repeat(p.length - 6)}${p.slice(-4)}`);
console.log(list.assignments.length ? "Shared iMessage line assignments:" : "No shared iMessage line assignments yet.");
for (const a of list.assignments) console.log(`  ${mask(a.handle)} → Clara number ${a.assignedPhoneNumber}${a.releasedAt ? " (released)" : ""}`);

const assign = flag("assign");
if (assign) {
  if (!/^\+[1-9]\d{1,14}$/.test(assign)) throw new Error("--assign needs an E.164 number like +15551234567");
  const a = await call<{ assignedPhoneNumber: string }>("POST", "/platforms/imessage/assignments", { handle: assign });
  console.log(`Assigned. ${mask(assign)} must text "hi" to ${a.assignedPhoneNumber} once, from Messages, before Clara can text them.`);
}

if (flag("webhook") !== null) {
  const url = flag("url") || "https://clara.living/api/photon/webhook";
  const versions = await call<{ apiVersions: Array<{ version: string; selectable: boolean; status: string }> }>("GET", "/webhooks/api-versions");
  const selectable = versions.apiVersions.filter((v) => v.selectable);
  const picked = (selectable.find((v) => v.status === "latest") ?? selectable.filter((v) => v.status !== "preview").sort((a, b) => a.version.localeCompare(b.version)).pop())?.version;
  if (!picked) throw new Error(`No selectable webhook API version in ${JSON.stringify(versions).slice(0, 300)}`);
  const created = await call<{ destination: { destinationId?: string }; signingSecret: string }>("POST", "/webhooks/destinations", {
    name: "Clara inbound replies",
    url,
    apiVersion: picked,
    enabledEvents: ["message.received"],
  });
  console.log(`Webhook destination ${created.destination.destinationId ?? ""} → ${url} (apiVersion ${picked}, message.received).`);
  console.log("Copy this into Render → clara-web → Environment as PHOTON_WEBHOOK_SECRET (shown only now):");
  console.log(`  ${created.signingSecret}`);
}

console.log("\nRender env: PHOTON_API_KEY (already set), PHOTON_PROJECT_ID=" + project + (flag("webhook") !== null ? ", PHOTON_WEBHOOK_SECRET (above)" : ", PHOTON_WEBHOOK_SECRET (run with --webhook)"));
