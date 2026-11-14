import { generateVAPIDKeys, sendNotification } from "web-push";

/**
 * Web push for the companion app. Subscriptions live in memory beside the network (keyed by volunteer id, several
 * devices each), and so do the VAPID keys when the environment has none: a restart resets both together, so a
 * subscription is never left signed by a key the server forgot. Every send has a deadline; a 404/410 from the push
 * service means the subscription is dead and it is dropped.
 */

export const PUSH_TIMEOUT_MS = 8_000;
/** Phones and laptops per volunteer; the oldest is dropped past this. */
export const MAX_DEVICES = 5;

/** A browser PushSubscription as JSON (`JSON.parse(JSON.stringify(sub))`). */
export interface PushSubscriptionJson {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

const B64URL = /^[A-Za-z0-9_\-=]+$/;

/** The subscription if the body is a well-formed one (https endpoint, base64url keys), else null. */
export function parseSubscription(value: unknown): PushSubscriptionJson | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { endpoint?: unknown; expirationTime?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof v.endpoint !== "string" || v.endpoint.length > 1000) return null;
  try {
    if (new URL(v.endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const p256dh = v.keys?.p256dh;
  const auth = v.keys?.auth;
  if (typeof p256dh !== "string" || p256dh.length < 16 || p256dh.length > 200 || !B64URL.test(p256dh)) return null;
  if (typeof auth !== "string" || auth.length < 8 || auth.length > 100 || !B64URL.test(auth)) return null;
  const expirationTime = typeof v.expirationTime === "number" ? v.expirationTime : null;
  return { endpoint: v.endpoint, expirationTime, keys: { p256dh, auth } };
}

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
  /** "env" from VAPID_* variables; "generated" at start (lost on restart). */
  source: "env" | "generated";
}

export type VapidEnv = { VAPID_PUBLIC_KEY?: string; VAPID_PRIVATE_KEY?: string; VAPID_SUBJECT?: string };

/** VAPID keys from the environment, or a fresh pair kept in memory (never written anywhere). */
export function resolveVapid(env: VapidEnv, log: (line: string) => void = console.log, generate = generateVAPIDKeys): Vapid {
  const subject = env.VAPID_SUBJECT?.trim() || "mailto:clara-demo@example.com";
  const pub = env.VAPID_PUBLIC_KEY?.trim();
  const priv = env.VAPID_PRIVATE_KEY?.trim();
  if (pub && priv) return { publicKey: pub, privateKey: priv, subject, source: "env" };
  const keys = generate();
  log("[push] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set: generated a key pair in memory (push subscriptions reset on restart).");
  return { publicKey: keys.publicKey, privateKey: keys.privateKey, subject, source: "generated" };
}

/** What a notification carries; the service worker (public/sw.js) shows it. */
export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  /** Show "I'M COMING" / "CAN'T" buttons (real alerts only). */
  actions?: boolean;
  data: Record<string, string | boolean | null>;
}

export interface PushSendOptions {
  TTL: number;
  urgency: "high" | "normal";
  timeout: number;
  vapidDetails: { subject: string; publicKey: string; privateKey: string };
}

/** The send function (web-push's sendNotification in production, a fake in tests). Resolves or throws `{ statusCode }`. */
export type PushSender = (sub: PushSubscriptionJson, payload: string, options: PushSendOptions) => Promise<{ statusCode: number }>;

export const webPushSender: PushSender = (sub, payload, options) => sendNotification(sub, payload, options);

export interface SendResult {
  sent: number;
  failed: number;
  removed: number;
}

export interface PushBook {
  readonly vapid: Vapid;
  /** Saves (or refreshes) a device; returns how many devices the volunteer now has. */
  save(volunteerId: string, sub: PushSubscriptionJson): number;
  /** Removes one device by endpoint, or all of the volunteer's devices; returns how many are left. */
  remove(volunteerId: string, endpoint?: string): number;
  devices(volunteerId: string): number;
  total(): number;
  send(volunteerId: string, payload: PushPayload): Promise<SendResult>;
  /** Resolves when every send started so far has finished (tests). */
  idle(): Promise<void>;
}

export function createPushBook({ vapid, sender = webPushSender, timeoutMs = PUSH_TIMEOUT_MS, log = console.log }: { vapid: Vapid; sender?: PushSender; timeoutMs?: number; log?: (line: string) => void }): PushBook {
  const subs = new Map<string, PushSubscriptionJson[]>();
  const pending = new Set<Promise<unknown>>();

  const withDeadline = <T,>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(Object.assign(new Error("push timed out"), { statusCode: 0 })), timeoutMs);
      t.unref?.();
      p.then(
        (v) => {
          clearTimeout(t);
          resolve(v);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });

  const book: PushBook = {
    vapid,
    save(volunteerId, sub) {
      const list = (subs.get(volunteerId) ?? []).filter((s) => s.endpoint !== sub.endpoint);
      list.push(sub);
      while (list.length > MAX_DEVICES) list.shift();
      subs.set(volunteerId, list);
      return list.length;
    },
    remove(volunteerId, endpoint) {
      if (endpoint === undefined) {
        subs.delete(volunteerId);
        return 0;
      }
      const list = (subs.get(volunteerId) ?? []).filter((s) => s.endpoint !== endpoint);
      if (list.length) subs.set(volunteerId, list);
      else subs.delete(volunteerId);
      return list.length;
    },
    devices: (volunteerId) => subs.get(volunteerId)?.length ?? 0,
    total: () => [...subs.values()].reduce((n, l) => n + l.length, 0),
    send(volunteerId, payload) {
      const list = [...(subs.get(volunteerId) ?? [])];
      const body = JSON.stringify(payload);
      const options: PushSendOptions = {
        TTL: 120,
        urgency: payload.actions ? "high" : "normal",
        timeout: timeoutMs,
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      };
      const run = (async (): Promise<SendResult> => {
        const result: SendResult = { sent: 0, failed: 0, removed: 0 };
        await Promise.all(
          list.map(async (sub) => {
            try {
              await withDeadline(sender(sub, body, options));
              result.sent++;
            } catch (error) {
              const status = (error as { statusCode?: number }).statusCode;
              if (status === 404 || status === 410) {
                book.remove(volunteerId, sub.endpoint);
                result.removed++;
              } else {
                result.failed++;
                log(`[push] send to a device of ${volunteerId} failed (${status || (error as Error).message}).`);
              }
            }
          }),
        );
        return result;
      })();
      pending.add(run);
      void run.finally(() => pending.delete(run));
      return run;
    },
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
  return book;
}
