"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Volunteer } from "@clara/contracts";
import { ApiError, api, postJson } from "../../lib/client";
import { isIos, isStandalone, registerSw, useInstallPrompt } from "../../lib/pushClient";
import { AlertsSetup } from "./AlertsSetup";
import { VOLUNTEER_KEY } from "./CompanionApp";
import { AvailabilityFields, HelpFields, NameFields, SkillsFields, VehicleFields, WhereFields, draftToBody, emptyDraft, problemIn, type Draft, type Section } from "./ProfileFields";

/**
 * Joining Clara, one question per screen (390 px first): welcome → how you help → name and phone → skills (first
 * aid only) → vehicle and languages → where and radius → availability → alerts → install. The volunteer is created
 * when they leave the availability step, so alerts can subscribe this device; going back after that edits the same
 * volunteer. Each screen has one orange button.
 */

type StepId = "welcome" | "help" | "name" | "skills" | "vehicle" | "where" | "availability" | "alerts" | "install";

const TITLES: Record<StepId, string> = {
  welcome: "Help your neighbors in an emergency",
  help: "How can you help?",
  name: "Your name and phone",
  skills: "Your first-aid skills",
  vehicle: "Vehicle and languages",
  where: "Where you usually are",
  availability: "When you're available",
  alerts: "Emergency alerts",
  install: "Put Clara on your home screen",
};

export function Onboarding() {
  const [d, setD] = useState<Draft>(emptyDraft);
  const [step, setStep] = useState<StepId>("welcome");
  const [volunteerId, setVolunteerId] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const install = useInstallPrompt();
  const set = (patch: Partial<Draft>) => setD((x) => ({ ...x, ...patch }));

  useEffect(() => {
    setExisting(window.localStorage.getItem(VOLUNTEER_KEY));
    void registerSw();
  }, []);

  const steps: StepId[] = ["welcome", "help", "name", ...(d.aid ? (["skills"] as const) : []), "vehicle", "where", "availability", "alerts", "install"];
  const index = Math.max(0, steps.indexOf(step));
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo({ top: 0 });
    heading.current?.focus();
  }, [step]);

  const go = (to: StepId) => {
    setError(null);
    setStep(to);
  };
  const back = () => index > 0 && go(steps[index - 1]!);

  async function save(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      if (!volunteerId) {
        const { volunteer } = await postJson<{ volunteer: Volunteer }>("/api/volunteers", draftToBody(d, "create"));
        window.localStorage.setItem(VOLUNTEER_KEY, volunteer.volunteer_id);
        setVolunteerId(volunteer.volunteer_id);
      } else {
        await api(`/api/volunteers/${encodeURIComponent(volunteerId)}`, { method: "PATCH", body: JSON.stringify(draftToBody(d, "patch")) });
      }
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function next() {
    if (busy) return;
    const section = (["help", "name", "skills", "vehicle", "where", "availability"] as string[]).includes(step) ? (step as Section) : null;
    const problem = section ? problemIn(section, d) : null;
    if (problem) {
      setError(problem);
      return;
    }
    if (step === "availability" && !(await save())) return;
    if (step === "install") {
      window.location.assign("/app");
      return;
    }
    go(steps[index + 1]!);
  }

  async function setConsent(value: boolean) {
    if (!volunteerId) return;
    try {
      await api(`/api/volunteers/${encodeURIComponent(volunteerId)}`, { method: "PATCH", body: JSON.stringify({ call_consent: value }) });
      set({ callConsent: value });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Couldn't save that. Try again.");
    }
  }

  const primary: Record<StepId, string> = {
    welcome: "Get started",
    help: "Next",
    name: "Next",
    skills: "Next",
    vehicle: "Next",
    where: "Next",
    availability: busy ? "Saving…" : volunteerId ? "Save and continue" : "Join Clara",
    alerts: "Next",
    install: "Open Clara",
  };

  return (
    <section className="stack onboarding" aria-labelledby="ob-h" style={{ gap: 16 }}>
      <div className="row between">
        {index > 0 ? (
          <button type="button" className="btn small ghost" onClick={back} aria-label="Back to the previous step">
            ← Back
          </button>
        ) : (
          <Link href="/" className="brand">
            Clara
          </Link>
        )}
        <span className="lbl" aria-hidden="true">
          Step {index + 1} of {steps.length}
        </span>
      </div>
      <div className="progress" role="progressbar" aria-label="Sign-up progress" aria-valuemin={1} aria-valuemax={steps.length} aria-valuenow={index + 1} aria-valuetext={`Step ${index + 1} of ${steps.length}: ${TITLES[step]}`}>
        <span style={{ width: `${((index + 1) / steps.length) * 100}%` }} />
      </div>
      <h1 id="ob-h" ref={heading} tabIndex={-1}>
        {TITLES[step]}
      </h1>

      {step === "welcome" ? (
        <div className="stack" style={{ gap: 12 }}>
          {existing && !volunteerId ? (
            <p className="notice">
              This phone is already signed up. <Link href="/app">Open the app</Link>, or continue to join again as someone new.
            </p>
          ) : null}
          <p>
            Clara is a network of first-aid boxes. When someone opens a box and asks for help, Clara alerts trained neighbors nearby, and drivers who can take a patient to
            hospital.
          </p>
          <div className="card">
            <span className="lbl">What we&apos;ll ask</span>
            <ul className="ticks">
              <li>Your name, and a phone number if you want a call as a backup</li>
              <li>How you can help: first aid, driving, or both</li>
              <li>Roughly where you are, and how far you&apos;d go</li>
              <li>Permission to send you loud alerts</li>
            </ul>
            <span className="small muted">You choose each time whether to go. You can change everything later in Profile.</span>
          </div>
          <p className="notice">HackPrinceton demo. Clara never replaces emergency services: in a real emergency, call your local emergency number.</p>
        </div>
      ) : null}
      {step === "help" ? <HelpFields d={d} set={set} /> : null}
      {step === "name" ? <NameFields d={d} set={set} /> : null}
      {step === "skills" ? <SkillsFields d={d} set={set} /> : null}
      {step === "vehicle" ? <VehicleFields d={d} set={set} /> : null}
      {step === "where" ? (
        <>
          <p className="muted small">{d.drive && !d.aid ? "Usually your home: ride requests are matched by distance from here." : "Where you usually are. Alerts are matched by distance from here."}</p>
          <WhereFields d={d} set={set} />
        </>
      ) : null}
      {step === "availability" ? <AvailabilityFields d={d} set={set} /> : null}
      {step === "alerts" && volunteerId ? (
        <div className="stack" style={{ gap: 12 }}>
          <p>
            {d.aid && d.drive
              ? "When there's an emergency near you, or a patient needs a ride, your phone rings loudly with buttons to answer, even with Clara closed."
              : d.drive
                ? "When a patient near you needs a ride, your phone rings loudly with I CAN DRIVE / CAN'T buttons, even with Clara closed."
                : "When there's an emergency near you, your phone rings loudly with I'M COMING / CAN'T buttons, even with Clara closed."}
          </p>
          <AlertsSetup volunteerId={volunteerId} hasPhone={Boolean(d.phone.trim())} callConsent={d.callConsent} onConsent={setConsent} />
        </div>
      ) : null}
      {step === "install" ? <InstallStep install={install} /> : null}

      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <button type="button" className="btn primary block huge" aria-disabled={busy || undefined} onClick={() => void next()}>
        {primary[step]}
      </button>
      {step === "availability" ? <p className="small muted">Your name, skills, vehicle and rough location are shared with this demo&apos;s dispatch console.</p> : null}
    </section>
  );
}

function InstallStep({ install }: { install: ReturnType<typeof useInstallPrompt> }) {
  const [ios, setIos] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    setIos(isIos());
    setStandalone(isStandalone());
  }, []);

  if (standalone || install.installed) return <p className="t-green">Clara is installed. Open it from your home screen like any app.</p>;
  if (ios)
    return (
      <div className="stack" style={{ gap: 12 }}>
        <p>On iPhone, Clara becomes an app from Safari:</p>
        <ol className="steps">
          <li>
            Tap <b>Share</b> (the square with an arrow) in Safari&apos;s toolbar.
          </li>
          <li>
            Scroll and tap <b>Add to Home Screen</b>.
          </li>
          <li>
            Tap <b>Add</b>, then open <b>Clara</b> from your home screen.
          </li>
          <li>
            In Clara, go to <b>Profile → Alerts</b> and turn alerts on.
          </li>
        </ol>
        <p className="notice">iPhone only delivers alerts to Clara once it&apos;s on your home screen (iOS 16.4 or later). In a Safari tab, alerts show only while the page is open.</p>
      </div>
    );
  return (
    <div className="stack" style={{ gap: 12 }}>
      <p>Installed, Clara opens full-screen, starts faster on a weak connection, and is easy to find when an alert arrives.</p>
      {install.canPrompt ? (
        <button
          type="button"
          className="btn block"
          onClick={async () => {
            const r = await install.prompt();
            setNote(r === "accepted" ? "Installing…" : r === "dismissed" ? "Not installed. You can install later from the browser menu." : null);
          }}
        >
          Install Clara
        </button>
      ) : (
        <p className="small muted">If your browser offers it, use its menu: Install app, or Add to Home screen.</p>
      )}
      {note ? (
        <p className="small" role="status">
          {note}
        </p>
      ) : null}
    </div>
  );
}
