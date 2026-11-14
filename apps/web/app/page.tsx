import Link from "next/link";
import { TopBar } from "../components/TopBar";
import { IconKit, IconPersonAdd, IconPhone, IconPin } from "../components/ClaraIcons";
import { ClaraBoxDemo } from "../components/landing/ClaraBoxDemo";

/** One incident from the demo, from the lid opening to the paramedics' report. Times are from the fictional scenario. */
const TIMELINE = [
  { at: "0:00", title: "The lid opens", body: "A switch wakes Clara, and she asks what happened." },
  { at: "0:10", title: "A compartment lights up", body: "Each step is spoken and shown on screen." },
  { at: "0:30", title: "Clara takes a closer look", body: "The camera checks the wound; the sensor reads pulse." },
  { at: "0:40", title: "Help is called", body: "Clara briefs the dispatcher and alerts trained neighbors." },
  { at: "1:15", title: "A volunteer says yes", body: "Only now does Clara say help is coming.", key: true },
  { at: "Arrival", title: "Paramedics get a report", body: "What was reported, what Clara saw, and what was done.", end: true },
] as const;

const SCREENS = [
  { href: "/app", title: "Companion app", body: "The alert, “I’m coming”, and ride offers on a volunteer’s phone.", Icon: IconPhone },
  { href: "/join", title: "Join the network", body: "Sign up to give first aid, drive, or both.", Icon: IconPersonAdd },
  { href: "/maintainer", title: "Network and boxes", body: "Battery, supplies, and restocking for every box.", Icon: IconKit },
  { href: "/map", title: "Kit map", body: "The nearest box and whether it’s ready to use.", Icon: IconPin },
] as const;

export default function Home() {
  return (
    <>
      {/* The same bar as every other page, outside the Signal theme so it looks and works the same. */}
      <TopBar />
      <div className="theme-signal landing">
        <main id="main">
          <section className="ld-wrap ld-hero" aria-labelledby="hero-h">
            <div className="ld-hero-copy">
              <h1 id="hero-h">First aid until help arrives.</h1>
              <p className="ld-lede">
                Open the box and Clara talks you through what to do, lights up the supplies you need, and gets trained neighbors on their way, so you can stay with the person who’s
                hurt.
              </p>
              <div className="ld-actions">
                <Link href="/join" className="ld-btn ld-btn-primary">
                  Join as a volunteer
                </Link>
                <Link href="/dashboard" className="ld-btn ld-btn-outline">
                  Open the dispatch console
                </Link>
              </div>
            </div>
            <ClaraBoxDemo />
          </section>

          <section id="lid" className="ld-band" aria-labelledby="lid-h">
            <div className="ld-wrap ld-section">
              <div className="ld-section-head">
                <h2 id="lid-h">What happens when the lid opens</h2>
                <p>One incident from our demo. The emergency call goes to a teammate’s phone, not real emergency services.</p>
              </div>
              <ol className="ld-timeline">
                {TIMELINE.map((t) => (
                  <li key={t.at} data-key={"key" in t || undefined} data-end={"end" in t || undefined}>
                    <span className="ld-dot" aria-hidden="true" />
                    <span className="time">{t.at}</span>
                    <span className="ld-tl-title">{t.title}</span>
                    <span className="ld-tl-body">{t.body}</span>
                  </li>
                ))}
              </ol>
            </div>
          </section>

          <section id="demo" className="ld-band ld-band-alt" aria-labelledby="demo-h">
            <div className="ld-wrap ld-section">
              <div className="ld-section-head">
                <h2 id="demo-h">Try the demo</h2>
                <p>Start an emergency from the dispatch console, then answer it from the companion app.</p>
              </div>
              <section className="card ld-flow" aria-labelledby="flow-h">
                <h3 id="flow-h">Run the flow without hardware</h3>
                <p>
                  In Dispatch, press <strong>Demo SOS</strong>. It posts the same <code>box.opened</code> and <code>sos.opened</code> events a box would. Then answer the alert in
                  the companion app.
                </p>
              </section>
              <div className="ld-demo">
                <Link href="/dashboard" className="ld-console">
                  <div className="ld-console-view" aria-hidden="true">
                    <div className="ld-console-map">
                      <span className="ld-ring" />
                      <span className="ld-incident" />
                      <span className="ld-mpin" style={{ left: "30%", top: "30%" }} />
                      <span className="ld-mpin" style={{ left: "62%", top: "38%" }} />
                      <span className="ld-mpin" style={{ left: "40%", top: "70%" }} />
                      <span className="ld-mpin" data-off="" style={{ left: "76%", top: "72%" }} />
                      <span className="ld-mbox" style={{ left: "18%", top: "62%" }} />
                      <span className="ld-mbox" style={{ left: "70%", top: "18%" }} />
                    </div>
                    <div className="ld-console-side">
                      <span className="ld-console-case">Severe bleeding</span>
                      <span className="ld-console-where">Clinic tent</span>
                      <span className="ld-console-row" data-first="">
                        Amina<span className="ld-chip-on">Coming</span>
                      </span>
                      <span className="ld-console-row">
                        Yusuf<span>Sent</span>
                      </span>
                      <span className="ld-console-row">
                        Tomas<span>Sent</span>
                      </span>
                    </div>
                  </div>
                  <div className="ld-console-foot">
                    <span className="ld-console-title">Dispatch console</span>
                    <span className="ld-console-body">Live emergencies, who’s been alerted, ride offers, and scene reports.</span>
                  </div>
                </Link>

                <ul className="ld-screens">
                  {SCREENS.map(({ href, title, body, Icon }) => (
                    <li key={href}>
                      <Link href={href} className="ld-screen">
                        <Icon size={28} />
                        <span className="ld-screen-title">{title}</span>
                        <span className="ld-screen-body">{body}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </section>
        </main>

        <footer className="ld-footer">
          <div className="ld-wrap">
            <p>
              Built at HackPrinceton Fall 2026 as a proof of concept. Demo data is fictional, the emergency call is simulated, and Clara has never been used on a patient. In a real
              emergency, call your local emergency number.
            </p>
          </div>
        </footer>
      </div>
    </>
  );
}
