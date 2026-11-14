"use client";

import { useState } from "react";
import { TopBar } from "../TopBar";
import { HealthView } from "./HealthView";
import { PlannerView } from "./PlannerView";

/** The Admin app: box health by area, and the CoStar + Matterport + Vexcel kit placement planner. */
export function AdminApp() {
  const [tab, setTab] = useState<"health" | "planner">("health");
  const [area, setArea] = useState("houston");
  return (
    <div className="adm">
      <TopBar current="/admin" title="Clara Admin">
        <div className="adm-tabs" role="tablist" aria-label="Admin sections">
          <button role="tab" aria-selected={tab === "health"} onClick={() => setTab("health")}>
            Network health
          </button>
          <button role="tab" aria-selected={tab === "planner"} onClick={() => setTab("planner")}>
            Kit planner
          </button>
        </div>
      </TopBar>
      {tab === "health" ? (
        <HealthView area={area} setArea={setArea} />
      ) : (
        <PlannerView
          onDeployed={() => {
            setArea("houston");
            setTab("health");
          }}
        />
      )}
    </div>
  );
}
