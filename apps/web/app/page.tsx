import Link from "next/link";
import { TopBar } from "../components/TopBar";

const PAGES = [
  { href: "/app", title: "Companion app", body: "Phone app for volunteers: alerts nearby, I'm coming, on the way, ride offers for drivers, kit map." },
  { href: "/join", title: "Join the network", body: "Volunteer sign-up: skills, vehicle and seats, location." },
  { href: "/maintainer", title: "Network and boxes", body: "Console: live map of helpers and boxes, box status, battery, supplies, restock." },
  { href: "/dashboard", title: "Dispatch and rides", body: "Console: emergencies, alerts and escalation, suggested driver, approve or reassign, scene report links." },
  { href: "/map", title: "Kit map", body: "Every box by status: ready, low stock, in use, offline." },
] as const;

export default function Home() {
  return (
    <>
      <TopBar />
      <main id="main" className="page stack">
        <section style={{ padding: "24px 0 8px" }}>
          <p className="lbl t-red">HackPrinceton proof of concept</p>
          <h1 style={{ fontSize: "2.2rem" }}>First aid until help arrives</h1>
          <p className="muted" style={{ maxWidth: 720 }}>
            AI-guided first-aid boxes plus a response network of nearby trained volunteers. Demo data is fictional, the 911 call on the box is a simulation, and Clara is never
            used on a patient.
          </p>
        </section>
        <div className="links">
          {PAGES.map((p) => (
            <Link key={p.href} href={p.href}>
              <div className="card" style={{ height: "100%" }}>
                <h2>{p.title}</h2>
                <p className="muted small">{p.body}</p>
              </div>
            </Link>
          ))}
        </div>
        <section className="card">
          <h2>Run the flow without hardware</h2>
          <p className="small">
            In Dispatch, press <strong>Demo SOS</strong>. It posts the same <code>box.opened</code> and <code>sos.opened</code> events a box would. Then answer the alert in the
            companion app.
          </p>
        </section>
      </main>
    </>
  );
}
