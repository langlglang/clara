import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createNetwork } from "@clara/network";
import { EVENTS_VERSION } from "@clara/contracts";
import { photonSipConfig, placeCall, twilioConfig } from "../lib/twilio";
import { briefText, createBriefBook } from "../lib/brief";
import { openSmsThread } from "../lib/photon";

const sipEnv = {
  TWILIO_ACCOUNT_SID: "AC" + "0".repeat(32),
  TWILIO_AUTH_TOKEN: "token",
  TWILIO_FROM_NUMBER: "+15550000000",
  PHOTON_SIP_SERVER: "sip.photon.codes:5061",
  PHOTON_SIP_USERNAME: "v-user",
  PHOTON_SIP_PASSWORD: "secret-password",
  PHOTON_VOICE_NUMBER: "+1 (304) 441-6645",
};
const photon = { apiKey: "key", projectId: "prj", webhookSecret: null, baseUrl: "https://api.photon.test" };

function sos(network: ReturnType<typeof createNetwork>, boxId = "box-clinic") {
  const session = randomUUID();
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();
  network.ingest({
    schema_version: EVENTS_VERSION,
    events: [
      { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(0), type: "box.opened" },
      { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(1), type: "report.heard", text: "his leg is bleeding a lot" },
      { event_id: randomUUID(), box_id: boxId, session_id: session, occurred_at: at(2), type: "sos.opened", need: "bleeding", source: "touch" },
    ],
  });
  return network.store.openIncidentForBox(boxId)!.incident;
}

describe("Photon voice (Twilio over SIP)", () => {
  it("reads the four PHOTON_SIP settings and needs all of them", () => {
    expect(photonSipConfig(sipEnv)).toEqual({ server: "sip.photon.codes:5061", username: "v-user", password: "secret-password", from: "+13044416645" });
    expect(photonSipConfig({ ...sipEnv, PHOTON_SIP_PASSWORD: "" })).toBeNull();
    expect(photonSipConfig({ ...sipEnv, PHOTON_VOICE_NUMBER: "3044416645" })).toBeNull();
    expect(twilioConfig({ ...sipEnv, PHOTON_SIP_USERNAME: undefined })?.photon).toBeNull();
  });

  it("dials through Photon's SIP server from the Photon number", async () => {
    const sent: URLSearchParams[] = [];
    const fake = async (_url: string, init: RequestInit) => {
      sent.push(new URLSearchParams(String(init.body)));
      return new Response(JSON.stringify({ sid: "CA1" }), { status: 201 });
    };
    let via = "";
    const sid = await placeCall(twilioConfig(sipEnv)!, "+17372583742", "<Response><Say>Hi</Say></Response>", fake, undefined, { onVia: (v) => (via = v) });
    expect(sid).toBe("CA1");
    expect(via).toBe("photon");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.get("To")).toBe("sip:+17372583742@sip.photon.codes:5061;transport=tls;secure=true");
    expect(sent[0]!.get("From")).toBe("+13044416645");
    expect(sent[0]!.get("SipAuthUsername")).toBe("v-user");
    expect(sent[0]!.get("SipAuthPassword")).toBe("secret-password");
  });

  it("falls back to the Twilio number when the Photon call is refused", async () => {
    const sent: URLSearchParams[] = [];
    const fake = async (_url: string, init: RequestInit) => {
      const p = new URLSearchParams(String(init.body));
      sent.push(p);
      return p.get("To")!.startsWith("sip:")
        ? new Response(JSON.stringify({ message: "SIP refused" }), { status: 400 })
        : new Response(JSON.stringify({ sid: "CA2" }), { status: 201 });
    };
    let via = "";
    const sid = await placeCall(twilioConfig(sipEnv)!, "+17372583742", "<Response><Say>Hi</Say></Response>", fake, undefined, { onVia: (v) => (via = v) });
    expect(sid).toBe("CA2");
    expect(via).toBe("twilio");
    const last = sent.at(-1)!;
    expect(last.get("To")).toBe("+17372583742");
    expect(last.get("From")).toBe("+15550000000");
    expect(last.has("SipAuthPassword")).toBe(false);
  });
});

describe("the written brief", () => {
  it("has the box, what was reported and the live report link", () => {
    const network = createNetwork();
    network.seedDemo();
    const incident = sos(network);
    const text = briefText(network, incident.incident_id, "https://clara.living")!;
    expect(text).toMatch(/^CLARA BRIEF \(demo\) · Clinic tent/);
    expect(text).toContain("The bystander reported: his leg is bleeding a lot");
    expect(text).toMatch(/Live report: https:\/\/clara\.living\/r\/[A-Z2-9]{6}$/);
    expect(text).not.toContain("This is Clara");
    expect(text.length).toBeLessThanOrEqual(700);
  });

  it("opens an SMS thread from the Photon number, even to a phone that never texted", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const fake = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname.replace("/v1/projects/prj", "");
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      if (path === "/users") return new Response(JSON.stringify({ id: body.handle === "+13044416645" ? "usr-agent" : "usr-peer" }), { status: 200 });
      return new Response(JSON.stringify({ id: "spc-1" }), { status: 200 });
    };
    const thread = await openSmsThread(photon, "+13044416645", "+17372583742", fake);
    expect(thread).toEqual({ spaceId: "spc-1", senderId: "usr-agent", platform: "sms" });
    expect(calls.find((c) => c.path === "/spaces")!.body).toEqual({ participantIds: ["usr-agent", "usr-peer"], platform: "sms" });
  });

  it("texts the dispatcher once, and only logs without Photon", async () => {
    const network = createNetwork();
    network.seedDemo();
    const incident = sos(network);
    const sentTexts: string[] = [];
    const fake = async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(String(init.body));
      if (path.endsWith("/messages")) sentTexts.push(body.content.text);
      return new Response(JSON.stringify({ id: path.endsWith("/users") ? `usr-${body.handle}` : "x" }), { status: 200 });
    };
    const book = createBriefBook({ network, photon, fromNumber: "+13044416645", baseUrl: "https://clara.living", fetch: fake, log: () => {} });
    expect((await book.dispatcher(incident.incident_id, "+17372583742"))?.status).toBe("sent");
    expect(await book.dispatcher(incident.incident_id, "+17372583742")).toBeNull();
    expect(sentTexts).toHaveLength(1);
    book.stop();

    const off = createBriefBook({ network, photon: null, fromNumber: null, baseUrl: "https://clara.living", log: () => {} });
    expect((await off.dispatcher(incident.incident_id, "+17372583742"))?.status).toBe("not_configured");
    off.stop();
  });
});
