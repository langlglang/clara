import Link from "next/link";
import { BrandMark } from "../components/TopBar";

const HELPERS = [
  { initials: "PN", name: "Priya Nair", detail: "Stop the Bleed · on foot", status: "Coming", tone: "blue", bg: "#DBE7FE", fg: "#1D4ED8" },
  { initials: "MO", name: "Marcus Okafor", detail: "Driver · 3 seats", status: "Suggested", tone: "grey", bg: "#FCE7D6", fg: "#9A3412" },
  { initials: "AR", name: "Ana Ribeiro", detail: "CPR · 600 m", status: "Alerted", tone: "grey", bg: "#DCF3E4", fg: "#166534" },
] as const;

export default function Home() {
  return (
    <>
      <header className="home-nav">
        <nav aria-label="Pages">
          <Link href="/" className="brand">
            <BrandMark />
            Clara
          </Link>
          <div className="links-row">
            <Link href="/app">Companion app</Link>
            <Link href="/maintainer">Network</Link>
            <Link href="/dashboard">Dispatch</Link>
            <Link href="/map">Kit map</Link>
          </div>
          <span style={{ flex: 1 }} />
          <Link href="/dashboard" className="btn dark small">
            Open Dispatch
          </Link>
        </nav>
      </header>

      <main id="main" className="home-wrap">
        <section className="hero">
          <div>
            <h1>Your first aid copilot</h1>
            <p className="lede">Clara guides you through first aid, briefs dispatchers for you, and calls for nearby help.</p>
            <div className="row" style={{ gap: 12 }}>
              <Link href="/dashboard" className="btn primary huge">
                Run a demo SOS
              </Link>
              <Link href="/join" className="btn huge" style={{ background: "var(--canvas)", borderColor: "transparent" }}>
                Join as a volunteer
              </Link>
            </div>
          </div>

          <div className="hero-art" role="img" aria-label="The Clara box showing step 2, press firmly on the wound, while a volunteer is three minutes away">
            <div className="blob" />
            <div className="blob2" />
            <div className="device">
              <div className="device-screen">
                <div className="row between">
                  <span className="pill" data-tone="red">
                    Step 2 of 5
                  </span>
                  <span className="small muted">Clinic tent</span>
                </div>
                <div className="device-step">Press firmly on the wound.</div>
                <p className="small muted" style={{ marginBottom: 18 }}>
                  Use the gauze from the top drawer. Keep pressing, even if it soaks through.
                </p>
                <div className="dots" aria-hidden="true">
                  <span className="on" />
                  <span className="on" />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            </div>
            <div className="float-chip" style={{ right: 28, bottom: 92 }}>
              <span className="avatar">PN</span>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>Priya is coming</div>
                <div className="small t-blue" style={{ fontWeight: 600, fontSize: 13 }}>
                  3 min away · on foot
                </div>
              </div>
            </div>
            <div className="float-chip" style={{ left: 36, bottom: 40, borderRadius: 999, padding: "8px 14px", fontSize: 13, fontWeight: 600 }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--ok)" }} />3 helpers alerted
            </div>
          </div>
        </section>

        <section className="zig" aria-label="How Clara works">
          <div>
            <div>
              <p className="kicker">Guidance</p>
              <h2>Talk to it like you would a person.</h2>
              <p className="body">
                Open the lid and Clara is ready for hands-free conversation. It walks you through treatment step by step, shows pictures on the touchscreen, and lights up the
                compartment that holds what you need.
              </p>
              <Link href="/map" className="more">
                Find a box on the kit map
              </Link>
            </div>
            <div className="panel stack" style={{ gap: 14 }} role="img" aria-label="A bystander asks for help out loud and Clara answers while lighting the top compartment">
              <div className="bubble me">He cut his leg and it won&apos;t stop bleeding.</div>
              <div className="bubble">
                <span className="voice" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                Press gauze firmly on the wound. It&apos;s in the top compartment. I&apos;ve lit it up for you.
              </div>
              <div className="kit" aria-hidden="true">
                <div className="drawer on">
                  <span className="led" />
                  Gauze · tourniquet
                </div>
                <div className="drawer">
                  <span className="led" />
                  Gloves · tape
                </div>
                <div className="drawer">
                  <span className="led" />
                  Burn gel · splint
                </div>
              </div>
            </div>
          </div>

          <div>
            <div className="panel stack" style={{ gap: 12 }} role="img" aria-label="Camera view of the injury next to a live pulse reading from the sensor">
              <div className="viewfinder" aria-hidden="true">
                <span className="corner tl" />
                <span className="corner tr" />
                <span className="corner bl" />
                <span className="corner br" />
                <span className="rec">Camera · live</span>
                <span className="vf-target" />
                <span className="vf-caption">
                  <span className="label-tag" data-label="observed">
                    Observed
                  </span>
                  Bleeding from lower left leg
                </span>
              </div>
              <div className="row" style={{ gap: 12, flexWrap: "nowrap" }}>
                <div className="tile grow" style={{ background: "#fff" }}>
                  <span className="lbl">Pulse sensor</span>
                  <span className="big">
                    112 <span className="small muted">bpm</span>
                  </span>
                </div>
                <svg className="spark" viewBox="0 0 160 48" aria-hidden="true" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M0 30h22l6-16 8 30 7-22 5 8h26l6-16 8 30 7-22 5 8h26l6-16 8 30 6-14" />
                </svg>
              </div>
            </div>
            <div>
              <p className="kicker">Diagnosis</p>
              <h2>It looks and measures, so you don&apos;t have to guess.</h2>
              <p className="body">
                Clara asks questions, sees the scene through a detachable camera, and reads a connected pulse sensor to help you work out what&apos;s wrong. Every reading
                comes from the hardware, never from the model.
              </p>
            </div>
          </div>

          <div>
            <div>
              <p className="kicker">Dispatch</p>
              <h2>Help gets called while your hands stay busy.</h2>
              <p className="body">
                While Clara talks to you, a second agent briefs 911 with what it has learned and passes the dispatcher&apos;s questions back to you. At the same time it texts
                nearby volunteers and drivers who have opted in.
              </p>
              <Link href="/dashboard" className="more">
                Open Dispatch
              </Link>
            </div>
            <div className="panel stack" style={{ gap: 12 }}>
              <div className="call">
                <div className="row between">
                  <span style={{ fontWeight: 700, fontSize: 14 }}>Briefing 911</span>
                  <span className="pill">Simulated call</span>
                </div>
                <p className="small" style={{ margin: 0 }}>
                  <b>Dispatcher:</b> Is he conscious and breathing?
                </p>
                <p className="small" style={{ margin: 0 }}>
                  <b className="t-red">Clara:</b> Yes. Pulse 112 from the sensor. Tourniquet on at 14:14.
                </p>
              </div>
              <ul className="list stack" style={{ gap: 8 }} aria-label="Example volunteers alerted">
                {HELPERS.map((h) => (
                  <li key={h.initials} className="row" style={{ background: "#fff", borderRadius: 14, padding: "10px 14px", border: 0, gap: 12, flexWrap: "nowrap" }}>
                    <span className="avatar" style={{ width: 36, height: 36, borderRadius: 11, fontSize: 13, background: h.bg, color: h.fg }}>
                      {h.initials}
                    </span>
                    <div className="grow">
                      <div style={{ fontSize: 14, fontWeight: 700 }}>{h.name}</div>
                      <div className="small muted" style={{ fontSize: 13 }}>
                        {h.detail}
                      </div>
                    </div>
                    <span className="pill" data-tone={h.tone}>
                      {h.status}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="band">
          <div>
            <h2 style={{ fontSize: 30, marginBottom: 10 }}>Run it without the hardware.</h2>
            <p>
              Press Demo SOS in Dispatch. It sends the same <code>box.opened</code> and <code>sos.opened</code> events a real lid would. Then answer the alert in the companion app.
            </p>
          </div>
          <Link href="/dashboard" className="btn primary huge">
            Start a demo SOS
          </Link>
        </section>
      </main>
    </>
  );
}
