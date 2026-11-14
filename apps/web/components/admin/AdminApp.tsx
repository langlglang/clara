"use client";

import { useEffect, useState } from "react";
import { TopBar } from "../TopBar";
import { HealthView } from "./HealthView";
import { PlannerView } from "./PlannerView";
import { RuralView } from "./RuralView";
import { adminJson } from "./api";

export const ADMIN_TOKEN_STORAGE_KEY = "clara-admin-token";

/** The Admin app: box health by area, and the CoStar + Matterport + Vexcel kit placement planner. */
export function AdminApp() {
  const [tab, setTab] = useState<"health" | "planner" | "rural">("health");
  const [area, setArea] = useState("houston");
  const [token, setToken] = useState<string | null>(null);
  const [entered, setEntered] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock(value: string) {
    if (!value.trim()) return;
    setChecking(true);
    setError(null);
    try {
      await adminJson("/api/admin/status", value);
      sessionStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, value);
      setToken(value);
      setEntered("");
    } catch {
      sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      setError("Admin token was not accepted.");
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    const saved = sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
    if (saved) void unlock(saved);
  }, []);
  return (
    <div className="adm">
      <TopBar current="/admin" title="Clara Admin">
        {token ? <><div className="adm-tabs" role="tablist" aria-label="Admin sections">
          <button role="tab" aria-selected={tab === "health"} onClick={() => setTab("health")}>
            Network health
          </button>
          <button role="tab" aria-selected={tab === "planner"} onClick={() => setTab("planner")}>
            Kit planner
          </button>
          <button role="tab" aria-selected={tab === "rural"} onClick={() => setTab("rural")}>
            Rural planner
          </button>
        </div><button type="button" className="btn small" onClick={() => { sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY); setToken(null); }}>Lock Admin</button></> : null}
      </TopBar>
      {!token ? (
        <main id="main" className="page stack" style={{ maxWidth: 480, margin: "4rem auto" }}>
          <h1>Admin access</h1>
          <form onSubmit={(event) => { event.preventDefault(); void unlock(entered); }} className="stack">
            <label htmlFor="admin-token">Admin token</label>
            <input id="admin-token" className="adm-input" type="password" autoComplete="off" value={entered} onChange={(event) => setEntered(event.target.value)} />
            <button className="btn primary" type="submit" disabled={checking || !entered.trim()}>{checking ? "Checking…" : "Open Admin"}</button>
          </form>
          {error ? <p className="error" role="alert">{error}</p> : null}
        </main>
      ) : tab === "health" ? (
        <HealthView area={area} setArea={setArea} token={token} />
      ) : tab === "rural" ? (
        <RuralView token={token} />
      ) : (
        <PlannerView
          token={token}
          onDeployed={() => {
            setArea("houston");
            setTab("health");
          }}
        />
      )}
    </div>
  );
}
