"use client";

import { useEffect, useState } from "react";
import type { Volunteer } from "@clara/contracts";
import { ApiError, api } from "../../lib/client";
import type { VehicleKind } from "../../lib/rides";
import { AlertsSetup } from "./AlertsSetup";
import { AvailabilityFields, HelpFields, NameFields, SkillsFields, VehicleFields, WhereFields, draftFromVolunteer, draftToBody, problemIn, type Draft, type Section } from "./ProfileFields";

/** The Profile tab: every sign-up answer, editable, saved with one PATCH; alerts on this device; sign out. */
export function ProfileEditor({ volunteer, vehicle, onSaved, onForget }: { volunteer: Volunteer; vehicle: VehicleKind; onSaved(): Promise<void> | void; onForget(): void }) {
  const [d, setD] = useState<Draft>(() => draftFromVolunteer(volunteer, vehicle));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);
  const set = (patch: Partial<Draft>) => {
    setD((x) => ({ ...x, ...patch }));
    setDirty(true);
    setMsg(null);
  };
  // Follow server changes (e.g. the Home switch) while nothing is being edited here.
  useEffect(() => {
    if (!dirty) setD(draftFromVolunteer(volunteer, vehicle));
  }, [volunteer, vehicle, dirty]);

  async function save() {
    if (busy) return;
    const sections: Section[] = ["help", "name", "skills", "vehicle", "where", "availability"];
    const problem = sections.map((s) => problemIn(s, d)).find(Boolean);
    if (problem) {
      setMsg({ text: problem, tone: "error" });
      return;
    }
    setBusy(true);
    try {
      await api(`/api/volunteers/${encodeURIComponent(volunteer.volunteer_id)}`, { method: "PATCH", body: JSON.stringify(draftToBody(d, "patch")) });
      setDirty(false);
      setMsg({ text: "Saved.", tone: "ok" });
      await onSaved();
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : "Couldn't save. Try again.", tone: "error" });
    } finally {
      setBusy(false);
    }
  }

  async function setConsent(value: boolean) {
    try {
      await api(`/api/volunteers/${encodeURIComponent(volunteer.volunteer_id)}`, { method: "PATCH", body: JSON.stringify({ call_consent: value }) });
      setD((x) => ({ ...x, callConsent: value }));
      await onSaved();
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : "Couldn't save that.", tone: "error" });
    }
  }

  return (
    <section aria-labelledby="me-h" className="stack" style={{ gap: 14 }}>
      <h1 id="me-h" tabIndex={-1}>
        Profile
      </h1>
      <div className="card">
        <span className="lbl">How you help</span>
        <HelpFields d={d} set={set} />
      </div>
      <div className="card">
        <span className="lbl">Name and phone</span>
        <NameFields d={d} set={set} />
      </div>
      {d.aid ? (
        <div className="card">
          <span className="lbl">First-aid skills</span>
          <SkillsFields d={d} set={set} />
        </div>
      ) : null}
      <div className="card">
        <span className="lbl">{d.drive ? "Vehicle and languages" : "Languages"}</span>
        <VehicleFields d={d} set={set} />
      </div>
      <div className="card">
        <span className="lbl">Where and how far</span>
        <WhereFields d={d} set={set} />
      </div>
      <div className="card">
        <span className="lbl">Availability</span>
        <AvailabilityFields d={d} set={set} />
      </div>
      {msg ? (
        <p className={msg.tone === "ok" ? "t-green" : "error"} role={msg.tone === "ok" ? "status" : "alert"}>
          {msg.text}
        </p>
      ) : null}
      <button type="button" className="btn primary block huge" aria-disabled={busy || !dirty || undefined} onClick={() => void save()}>
        {busy ? "Saving…" : dirty ? "Save changes" : "Saved"}
      </button>

      <h2 id="alerts-h" style={{ marginTop: 10 }}>
        Alerts
      </h2>
      <AlertsSetup volunteerId={volunteer.volunteer_id} hasPhone={Boolean(volunteer.phone)} callConsent={volunteer.call_consent ?? false} onConsent={setConsent} channel={volunteer.channel} />

      <button type="button" className="btn block" onClick={onForget}>
        Sign out on this phone
      </button>
      <p className="small muted">Signing out forgets your id on this phone only.</p>
    </section>
  );
}
