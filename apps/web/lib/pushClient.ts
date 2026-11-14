"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "./client";

/**
 * Browser side of the PWA: the service worker (public/sw.js), notification permission and the push subscription,
 * the install prompt, and iPhone detection. Every function is safe to call where a feature is missing.
 */

export const isIos = () =>
  typeof navigator !== "undefined" && (/iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));

export const isStandalone = () =>
  typeof window !== "undefined" && (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);

export const pushSupported = () => typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export const permission = (): NotificationPermission | "unsupported" => (typeof window !== "undefined" && "Notification" in window ? Notification.permission : "unsupported");

/** Registers /sw.js at scope "/" (once per page; later calls return the same registration). */
export async function registerSw(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch {
    return null;
  }
}

function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await registerSw();
  return reg ? reg.pushManager.getSubscription() : null;
}

export type EnableResult = "ok" | "denied" | "unsupported" | "error";

/** Asks for notification permission, subscribes with the server's VAPID key, and saves the subscription. */
export async function enablePush(volunteerId: string): Promise<{ result: EnableResult; message?: string }> {
  if (!pushSupported()) return { result: "unsupported" };
  const asked = await Notification.requestPermission();
  if (asked !== "granted") return { result: "denied" };
  try {
    const reg = await registerSw();
    if (!reg) return { result: "unsupported" };
    await navigator.serviceWorker.ready;
    const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
    let sub = await reg.pushManager.getSubscription();
    // A subscription made with an older key (the demo server restarted and generated a new pair) must be replaced.
    const current = sub?.options.applicationServerKey ? btoa(String.fromCharCode(...new Uint8Array(sub.options.applicationServerKey))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") : null;
    if (sub && current !== publicKey.replace(/=+$/, "")) {
      await sub.unsubscribe().catch(() => undefined);
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
    await api(`/api/volunteers/${encodeURIComponent(volunteerId)}/push`, { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) });
    return { result: "ok" };
  } catch (e) {
    return { result: "error", message: e instanceof ApiError ? e.message : "Couldn't turn on alerts on this device." };
  }
}

export async function disablePush(volunteerId: string): Promise<void> {
  const sub = await currentSubscription().catch(() => null);
  if (!sub) return;
  await api(`/api/volunteers/${encodeURIComponent(volunteerId)}/push`, { method: "DELETE", body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => undefined);
  await sub.unsubscribe().catch(() => undefined);
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** Chrome / Edge / Android: the deferred install prompt (null until the browser offers one). */
export function useInstallPrompt() {
  const [event, setEvent] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(isStandalone());
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvent(e as InstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setEvent(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return {
    canPrompt: event !== null,
    installed,
    async prompt(): Promise<"accepted" | "dismissed" | "unavailable"> {
      if (!event) return "unavailable";
      await event.prompt();
      const { outcome } = await event.userChoice;
      setEvent(null);
      if (outcome === "accepted") setInstalled(true);
      return outcome;
    },
  };
}
