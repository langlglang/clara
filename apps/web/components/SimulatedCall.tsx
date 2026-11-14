"use client";

import { useEffect, useRef, useState } from "react";

type Line = { text: string; kind: string };
type Briefing = { incident_id: string; lines: Line[]; box_name: string; need: string; opened_at: string; closed: boolean; voice: boolean };

const KIND_LABEL: Record<string, string> = {
  intro: "Clara",
  location: "Location",
  need: "Emergency",
  reported: "Reported by bystander",
  timer: "Guidance timer",
  network: "Network",
  time: "Time",
};

/**
 * A scripted demo of Clara's 911 call: looks like a phone call to a dispatcher and speaks the briefing in Clara's
 * Cartesia voice (never the browser's voice). Nothing is dialled; it says so throughout.
 */
export function SimulatedCall({ id }: { id: string }) {
  const [b, setB] = useState<Briefing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const [draftToken, setDraftToken] = useState("");
  const [state, setState] = useState<"ready" | "preparing" | "ringing" | "talking" | "ended">("ready");
  const [current, setCurrent] = useState(-1);
  const [seconds, setSeconds] = useState(0);
  const stop = useRef(false);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem("clara-admin-token") ?? "";
    setToken(saved);
    setDraftToken(saved);
  }, []);

  useEffect(() => {
    if (!token) return;
    let alive = true;
    fetch(`/api/incidents/${encodeURIComponent(id)}/briefing`, { cache: "no-store", headers: { "x-clara-admin-token": token } })
      .then(async (r) => {
        if (r.status === 403) throw new Error("Admin credential was rejected.");
        if (!r.ok) throw new Error(r.status === 404 ? "No emergency to call about yet. Open an SOS on a box first." : `Couldn't load the call (${r.status}).`);
        return (await r.json()) as Briefing;
      })
      .then((data) => { if (alive) { setB(data); setError(null); } })
      .catch((e: Error) => { if (alive) { setError(e.message); if (e.message.includes("credential")) { setToken(""); sessionStorage.removeItem("clara-admin-token"); } } });
    return () => {
      alive = false;
    };
  }, [id, token]);

  useEffect(() => {
    if (state !== "talking" && state !== "ringing") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [state]);

  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** One line in Clara's Cartesia voice, retried a few times. Throws if Cartesia can't voice it. */
  async function fetchLine(incidentId: string, i: number): Promise<string> {
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await wait(700 * attempt);
      try {
        const response = await fetch(`/api/incidents/${encodeURIComponent(incidentId)}/briefing/audio?line=${i}`, { headers: { "x-clara-admin-token": token } });
        if (response.ok) return URL.createObjectURL(await response.blob());
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        last = body?.message ?? `HTTP ${response.status}`;
        if (response.status === 403 || response.status === 404) break;
      } catch {
        last = "network error";
      }
    }
    throw new Error(last || "Cartesia didn't answer");
  }

  function playUrl(url: string): Promise<void> {
    const el = new Audio(url);
    audio.current = el;
    return new Promise<void>((resolve, reject) => {
      el.onended = () => resolve();
      el.onerror = () => reject(new Error("audio"));
      el.play().catch(reject);
    });
  }

  async function start() {
    if (!b) return;
    if (!b.voice) {
      setError("Clara's Cartesia voice isn't set up on the server (CARTESIA_API_KEY), so the call can't play.");
      return;
    }
    stop.current = false;
    setError(null);
    setSeconds(0);
    // Every line is voiced before the phone rings, so the call never stalls or switches voice halfway.
    setState("preparing");
    const urls: string[] = [];
    try {
      for (let i = 0; i < b.lines.length; i++) {
        if (stop.current) return;
        urls.push(await fetchLine(b.incident_id, i));
      }
    } catch (e) {
      urls.forEach((u) => URL.revokeObjectURL(u));
      setState("ready");
      setError(`Cartesia couldn't voice the call (${(e as Error).message}). Press play to try again.`);
      return;
    }
    setState("ringing");
    await wait(2200);
    try {
      if (stop.current) return;
      setState("talking");
      for (let i = 0; i < b.lines.length; i++) {
        if (stop.current) return;
        setCurrent(i);
        await playUrl(urls[i]!).catch(() => {});
        await wait(250);
      }
      if (!stop.current) {
        setCurrent(-1);
        setState("ended");
      }
    } finally {
      urls.forEach((u) => URL.revokeObjectURL(u));
    }
  }

  function hangUp() {
    stop.current = true;
    audio.current?.pause();
    setCurrent(-1);
    setState("ended");
  }

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <main id="main" className="page stack" style={{ maxWidth: 520, gap: 16, minHeight: "100vh" }}>
      <header className="stack" style={{ gap: 6, textAlign: "center", paddingTop: 24 }}>
        <span className="lbl t-red">Simulated call · no real emergency number is dialled</span>
        <span className="lbl muted">Clara → 911 dispatcher</span>
        <h1 style={{ margin: "8px 0 0", fontSize: 40, letterSpacing: "0.04em" }}>911</h1>
        <span className="mono big" aria-live="polite">
          {state === "ready" ? "READY" : state === "preparing" ? "PREPARING CLARA'S VOICE…" : state === "ringing" ? "CALLING…" : state === "talking" ? mmss : "CALL ENDED"}
        </span>
        {b ? (
          <span className="small muted">
            {b.box_name} · {b.need === "bleeding" ? "Severe bleeding" : b.need === "breathing" ? "Breathing / CPR" : "First aid"}
          </span>
        ) : null}
      </header>

      {!token ? (
        <form onSubmit={(e) => { e.preventDefault(); const value = draftToken.trim(); if (!value) return; sessionStorage.setItem("clara-admin-token", value); setToken(value); setError(null); }} className="stack" style={{ gap: 8 }}>
          <label htmlFor="call-admin-token">Admin credential</label>
          <input id="call-admin-token" type="password" autoComplete="off" value={draftToken} onChange={(e) => setDraftToken(e.target.value)} />
          <button type="submit" className="btn">OPEN CALL BRIEFING</button>
        </form>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
      {token && !b && !error ? <p className="lbl" style={{ textAlign: "center" }}>Loading…</p> : null}

      {b ? (
        <section className="card stack" style={{ gap: 10 }} aria-label="What Clara tells the dispatcher">
          {b.lines.map((line, i) => (
            <div
              key={i}
              className="stack"
              style={{
                gap: 2,
                paddingLeft: 10,
                borderLeft: `3px solid ${i === current ? "var(--accent)" : "var(--border)"}`,
                opacity: state === "ready" || i <= current || state === "ended" ? 1 : 0.45,
                transition: "opacity 200ms, border-color 200ms",
              }}
            >
              <span className={`lbl ${line.kind === "reported" ? "t-amber" : line.kind === "network" ? "t-blue" : "muted"}`}>
                {KIND_LABEL[line.kind] ?? line.kind}
              </span>
              <span>{line.text}</span>
            </div>
          ))}
        </section>
      ) : null}

      <div className="stack" style={{ gap: 10, marginTop: "auto", paddingBottom: 24 }}>
        {state === "ready" || state === "ended" ? (
          <button type="button" className="btn primary block" style={{ minHeight: 64, fontSize: 18 }} onClick={start} disabled={!b}>
            {state === "ended" ? "PLAY CALL AGAIN" : "PLAY SIMULATED 911 CALL"}
          </button>
        ) : (
          <button type="button" className="btn block" style={{ minHeight: 64, fontSize: 18, borderColor: "var(--accent)", color: "var(--accent)" }} onClick={hangUp}>
            HANG UP
          </button>
        )}
        <p className="small muted" style={{ textAlign: "center", margin: 0 }}>
          {b?.voice ? "Clara's voice (Cartesia)." : "Cartesia isn't set up on the server."} Built only from what happened at the box.
        </p>
      </div>
    </main>
  );
}
