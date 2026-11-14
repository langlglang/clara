"use client";

import { clockShort } from "../../lib/client";
import type { CareVerdict, RideRequestEntry, TimeToCare } from "@clara/coordinator";
import type { CoordinatorView } from "../../lib/views";
import { StatusPill } from "../TopBar";

const MARK: Record<string, string> = { completed: "✓", in_progress: "▸", pending: "○" };
const STATUS: Record<string, string> = { idle: "idle", queued: "queued", running: "planning…", stopped: "stopped" };

/**
 * The response coordinator on the dispatch console: DEEP AGENT or RULES badge, the live plan, actions with reasons,
 * dispatch notes and needs-a-human flags. Everything here is advisory; dispatchers still approve rides and decide.
 */
export function CoordinatorPanel({ c }: { c: CoordinatorView }) {
  if (c.mode === "off")
    return (
      <div className="card">
        <span className="lbl">Coordinator</span>
        <span className="small muted">Off. Set ANTHROPIC_API_KEY (deep agent) or CLARA_COORDINATOR=rules on the server.</span>
      </div>
    );
  const log = c.log;
  const lastRun = log?.runs.at(-1) ?? null;
  const acts = (log?.actions ?? []).filter((a) => a.kind === "act" && a.tool !== "post_dispatch_note" && a.tool !== "flag_for_dispatcher").slice(-6).reverse();
  const reads = (log?.actions ?? []).filter((a) => a.kind === "read").length;

  return (
    <section className="card" aria-labelledby="coord-h" style={{ gap: 8 }}>
      <div className="row between">
        <span id="coord-h" className="lbl">
          Coordinator
        </span>
        <StatusPill tone={c.mode === "deep_agent" ? "blue" : "grey"}>{c.mode === "deep_agent" ? "DEEP AGENT" : "RULES"}</StatusPill>
      </div>
      <span className="small muted mono">
        {log ? `${STATUS[log.status] ?? log.status} · run ${log.runs.length}/10` : "waiting for the first run"}
        {lastRun?.ms != null ? ` · ${(lastRun.ms / 1000).toFixed(1)} s` : ""}
        {lastRun && lastRun.outcome !== "ok" && lastRun.outcome !== "running" ? ` · ${lastRun.outcome}` : ""}
        {c.model ? ` · ${c.model}` : ""}
        {log ? ` · ${log.extra_alerts}/6 extra alerts · ${reads} reads` : ""}
      </span>

      {log?.flags.map((f, i) => (
        <span key={i} className="small t-red" role="status">
          <b>NEEDS A HUMAN:</b> {f.reason}
        </span>
      ))}

      {log && log.plan.length ? (
        <ul className="list small" aria-label="Coordinator plan" style={{ margin: 0 }}>
          {log.plan.map((p, i) => (
            <li key={i} style={{ borderTop: 0, padding: "1px 0" }} className={p.status === "completed" ? "muted" : undefined}>
              <span className={`mono ${p.status === "completed" ? "t-green" : p.status === "in_progress" ? "t-amber" : ""}`} aria-label={p.status}>
                {MARK[p.status] ?? "○"}
              </span>{" "}
              {p.content}
            </li>
          ))}
        </ul>
      ) : null}

      {log?.time_to_care ? <TimeToCareBlock t={log.time_to_care} request={log.ride_request ?? null} /> : null}

      {acts.length ? (
        <div className="stack" style={{ gap: 3 }}>
          <span className="lbl">Actions</span>
          {acts.map((a, i) => (
            <span key={i} className={`small ${a.ok ? "" : "muted"}`}>
              <span className="mono muted">{clockShort(a.at)}</span> {a.ok ? a.result : `Refused ${a.tool.replace(/_/g, " ")}: ${a.result}`}
              {a.ok && a.reason ? <span className="muted"> — {a.reason}</span> : null}
            </span>
          ))}
        </div>
      ) : null}

      {log?.subagents.length ? (
        <div className="stack" style={{ gap: 3 }}>
          <span className="lbl">Subagents</span>
          {log.subagents.slice(-2).map((s, i) => (
            <span key={i} className="small">
              <b>{s.name}</b> <span className="muted">{s.result.length > 160 ? `${s.result.slice(0, 159)}…` : s.result}</span>
            </span>
          ))}
        </div>
      ) : null}

      {log?.notes.length ? (
        <div className="stack" style={{ gap: 3 }}>
          <span className="lbl">Dispatch notes</span>
          {log.notes.slice(-3).reverse().map((n, i) => (
            <span key={i} className="small">
              <span className="mono muted">{clockShort(n.at)}</span> {n.text}
            </span>
          ))}
        </div>
      ) : null}
      <span className="small muted">
        Advisory: it can alert listed helpers, ask a nearby box for its kit and propose a driver for you to approve. It requests a ride itself only when the simulated ambulance is late and a driver is 10+ min faster; you can cancel or reassign.
      </span>
    </section>
  );
}

const VERDICT: Record<CareVerdict, { text: string; tone: "green" | "amber" | "red" | "grey" }> = {
  ambulance_in_time: { text: "AMBULANCE IN TIME", tone: "green" },
  ambulance_late_driver_faster: { text: "AMBULANCE LATE · DRIVER FASTER", tone: "amber" },
  both_late: { text: "BOTH LATE", tone: "red" },
  no_driver: { text: "AMBULANCE LATE · NO DRIVER", tone: "red" },
  unknown: { text: "UNKNOWN", tone: "grey" },
};
const TONE_CLASS = { green: "t-green", amber: "t-amber", red: "t-red", grey: "muted" } as const;
const mins = (n: number) => `~${Math.max(0, Math.ceil(n))} min`;

/** Time to care: the simulated ambulance vs the best volunteer driver against the scenario's demo deadline. */
function TimeToCareBlock({ t, request }: { t: TimeToCare; request: RideRequestEntry | null }) {
  const v = VERDICT[t.verdict];
  return (
    <div className="stack" style={{ gap: 3 }} aria-label="Time to care">
      <div className="row between">
        <span className="lbl">Time to care</span>
        <span className={`small mono ${TONE_CLASS[v.tone]}`}>
          <b>{v.text}</b>
        </span>
      </div>
      <span className="small mono">
        <span className="lbl">Ambulance</span>{" "}
        {t.ambulance ? `scene ${mins(t.ambulance.scene_in_min)}, hospital ${mins(t.ambulance.hospital_in_min)}` : "ETA not set"}{" "}
        <span className="muted">(simulated 911 call, demo ETA)</span>
      </span>
      <span className="small mono">
        <span className="lbl">Driver</span> {t.driver ? `${t.driver.name}, pickup ${mins(t.driver.pickup_min)}, hospital ${mins(t.driver.hospital_in_min)}` : "no suitable driver free"}
      </span>
      <span className="small mono">
        <span className="lbl">Deadline</span> {t.deadline.reach_hospital_within_min} min from SOS <span className="muted">(demo value) · {Math.max(0, Math.floor(t.deadline.minutes_left))} min left</span>
      </span>
      {request ? (
        <span className="small t-amber">
          <b>Ride requested by coordinator:</b> {request.reason} <span className="muted">(offered to {request.offered_to.join(", ")})</span>
        </span>
      ) : null}
    </div>
  );
}
