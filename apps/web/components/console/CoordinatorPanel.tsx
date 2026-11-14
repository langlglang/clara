"use client";

import { clockShort } from "../../lib/client";
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
      <span className="small muted">Advisory only: it can alert listed helpers, ask a nearby box for its kit and propose a driver. You approve rides.</span>
    </section>
  );
}
