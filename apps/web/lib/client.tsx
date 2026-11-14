"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Browser-side plumbing for every page: one fetch with a deadline and the server's JSON error envelope, and a
 * hook that keeps a JSON view fresh from the live stream (`/api/stream`), with polling as a fallback when the
 * stream drops. The pattern (one request at a time, a refresh queued behind a running one, refetch when the
 * tab becomes visible) follows Sophi's usePhone (see components/companion/CompanionApp.tsx).
 */

export const DEADLINE_MS = 8_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly body?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), DEADLINE_MS);
  let res: Response;
  let body: unknown;
  try {
    res = await fetch(path, {
      ...init,
      signal: deadline.signal,
      headers: init.body ? { "content-type": "application/json" } : undefined,
      cache: "no-store",
    });
    body = await res.json().catch(() => null);
  } catch {
    throw new ApiError(0, "network", "Couldn't reach the server.");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "server_error", err?.message ?? `The server answered ${res.status}.`, body);
  }
  return body as T;
}

export const postJson = <T,>(path: string, body?: unknown) => api<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

export type LiveStatus = "connecting" | "live" | "polling";

export interface Live<T> {
  data: T | null;
  error: ApiError | null;
  status: LiveStatus;
  refresh(): Promise<void>;
}

/**
 * Fetches `path` now, again whenever the network reports a change (debounced), every `pollMs` while the
 * stream is down, and when the tab comes back into view. `path` null pauses it.
 */
export function useLive<T>(path: string | null, { pollMs = 5_000, debounceMs = 200 }: { pollMs?: number; debounceMs?: number } = {}): Live<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const running = useRef<Promise<void> | null>(null);
  const queued = useRef<Promise<void> | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!path) return;
    try {
      setData(await api<T>(path));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, "network", "Couldn't reach the server."));
    }
  }, [path]);

  const refresh = useCallback((): Promise<void> => {
    if (!running.current) {
      const run = fetchOnce().finally(() => {
        running.current = null;
      });
      running.current = run;
      return run;
    }
    queued.current ??= running.current.then(() => {
      queued.current = null;
      return refresh();
    });
    return queued.current;
  }, [fetchOnce]);

  useEffect(() => {
    if (!path) return;
    setData(null);
    void refresh();
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const source = new EventSource("/api/stream");
    source.onopen = () => setStatus("live");
    source.onerror = () => setStatus("polling");
    source.addEventListener("change", () => {
      if (debounce) return;
      debounce = setTimeout(() => {
        debounce = null;
        void refresh();
      }, debounceMs);
    });
    const poll = setInterval(() => {
      if (document.visibilityState === "visible" && source.readyState !== EventSource.OPEN) void refresh();
    }, pollMs);
    // A slow heartbeat refresh even while live, so "last seen" times keep moving.
    const slow = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 15_000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      source.close();
      if (debounce) clearTimeout(debounce);
      clearInterval(poll);
      clearInterval(slow);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, refresh, pollMs, debounceMs]);

  return { data, error, status, refresh };
}

/** A polite live region: `announce(text)` reads it once (a toggled zero-width space makes repeats re-read). */
export function useAnnouncer() {
  const [a, setA] = useState({ text: "", n: 0 });
  const announce = useCallback((text: string) => setA((prev) => ({ text, n: prev.n + 1 })), []);
  const region = (
    <p className="visually-hidden" role="status" aria-live="polite">
      {a.text}
      {a.n % 2 ? "​" : ""}
    </p>
  );
  return { announce, region };
}

// ---- Words shared by the pages ----

export const BOX_STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "grey" }> = {
  ready: { label: "Ready", tone: "green" },
  low_supplies: { label: "Low stock", tone: "amber" },
  in_use: { label: "In use", tone: "red" },
  offline: { label: "Offline", tone: "grey" },
};

export const ALERT_STATE: Record<string, { label: string; tone: "green" | "amber" | "red" | "grey" | "blue" }> = {
  sent: { label: "Sent", tone: "grey" },
  shown: { label: "Seen", tone: "blue" },
  coming: { label: "Coming", tone: "green" },
  declined: { label: "Declined", tone: "amber" },
  arrived: { label: "Arrived", tone: "green" },
  expired: { label: "Expired", tone: "grey" },
  cancelled: { label: "Cancelled", tone: "grey" },
};

export const NEED_LABEL: Record<string, string> = { bleeding: "Severe bleeding", breathing: "Breathing / CPR", general: "First aid" };

export const SKILL_LABEL: Record<string, string> = {
  stop_the_bleed: "Stop the Bleed",
  cpr: "CPR",
  first_aid: "First aid",
  nurse: "Nurse",
  doctor: "Doctor",
  emt: "EMT / paramedic",
  midwife: "Midwife",
  driver: "Driver",
};

export function agoWords(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return `${h} h ago`;
}

export function clock(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
}

export const km = (d: number) => (d < 1 ? `${Math.round(d * 1000)} m` : `${d.toFixed(1)} km`);

/** Re-renders every `ms` so relative times stay fresh. */
export function useNow(ms = 5_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Google Maps walking directions to a point (opens the phone's map app). */
export const directionsUrl = (lat: number, lng: number) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=walking`;

/** "2:14" (hours and minutes, no seconds). */
export function clockShort(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso)).replace(/\s?[AP]M$/, "");
}
