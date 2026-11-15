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
            <p className="eyebrow">HackPrinceton proof of concept</p>
            <h1>First aid until help arrives.</h1>
            <p className="lede">A box that walks anyone through the next step out loud, and nearby volunteers with first-aid training who get the alert and come.</p>
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
              <p className="kicker">The box</p>
              <h2>One step at a time, out loud.</h2>
              <p className="body">Open the lid and Clara talks. It lights the right drawer, starts the tourniquet timer, and never guesses a diagnosis.</p>
              <Link href="/map" className="more">
                See every box on the kit map
              </Link>
            </div>
            <div className="panel tiles three">
              <div className="tile" style={{ background: "#fff" }}>
                <span className="lbl">Drawer</span>
                <span className="big">Top</span>
              </div>
              <div className="tile">
                <span className="lbl">TQ timer</span>
                <span className="big t-red">06:42</span>
              </div>
              <div className="tile" style={{ background: "#fff" }}>
                <span className="lbl">Pulse</span>
                <span className="big">112</span>
              </div>
            </div>
          </div>

          <div>
            <ul className="panel list stack" style={{ gap: 10, padding: 20 }} aria-label="Example helpers">
              {HELPERS.map((h) => (
                <li key={h.initials} className="row" style={{ background: "#fff", borderRadius: 14, padding: "12px 14px", border: 0, gap: 12, flexWrap: "nowrap" }}>
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
            <div>
              <p className="kicker">The volunteers</p>
              <h2>Trained neighbors, a tap away.</h2>
              <p className="body">Volunteers in range get an alert with what happened and where. The first to say yes shows up on the box screen by name.</p>
              <Link href="/app" className="more">
                Open the companion app
              </Link>
            </div>
          </div>

          <div>
            <div>
              <p className="kicker">Dispatch</p>
              <h2>Everyone sees the same scene.</h2>
              <p className="body">Coordinators watch helpers move, approve a driver, and hand a scene report to the ambulance crew.</p>
              <Link href="/dashboard" className="more">
                Open Dispatch
              </Link>
            </div>
            <div className="panel" style={{ height: 240, position: "relative", overflow: "hidden", padding: 0 }} aria-hidden="true">
              <svg width="100%" height="100%" viewBox="0 0 520 240" preserveAspectRatio="xMidYMid slice" fill="none" stroke="#EADFDB" strokeWidth="10" strokeLinecap="round">
                <path d="M-20 70 C120 60 220 110 540 90" />
                <path d="M-20 190 C140 170 300 200 540 160" />
                <path d="M150 -20 C160 80 170 160 140 260" />
                <path d="M360 -20 C350 90 380 170 400 260" />
              </svg>
              <span style={{ position: "absolute", left: "44%", top: "40%", width: 22, height: 22, borderRadius: "50%", background: "var(--accent)", boxShadow: "0 0 0 10px rgba(212,42,47,0.18)" }} />
              <span style={{ position: "absolute", left: "24%", top: "62%", width: 14, height: 14, borderRadius: "50%", background: "var(--info)", border: "3px solid #fff" }} />
              <span style={{ position: "absolute", left: "68%", top: "26%", width: 14, height: 14, borderRadius: "50%", background: "var(--info)", border: "3px solid #fff" }} />
              <span style={{ position: "absolute", left: "76%", top: "70%", width: 16, height: 16, borderRadius: 5, background: "var(--ok)", border: "3px solid #fff" }} />
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

      <footer className="site-foot">
        <div>Clara is a proof of concept. Demo data is fictional, the 911 call is simulated, and Clara is never used on a patient.</div>
      </footer>
    </>
  );
}
