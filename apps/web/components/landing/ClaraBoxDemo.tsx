"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The landing page's animated Clara box: a short scripted exchange from the fictional demo, with the gauze
 * compartment lighting up. With reduced motion it shows the finished exchange at once, without timers.
 * Clara only says a volunteer is coming in the last line, after the volunteer has said yes.
 */

const LINES = [
  { who: "You", text: "My friend cut his arm and it’s bleeding a lot.", tone: "you" },
  { who: "Clara", text: "Open the compartment that’s lit up and take out the gauze.", tone: "clara" },
  { who: "Clara", text: "Press it hard on the wound and keep holding. I’m calling for help.", tone: "clara" },
  { who: "Clara", text: "Amina, a trained volunteer, said yes. She’s on her way.", tone: "ok" },
] as const;

const SLOTS = ["Gloves", "Gauze", "Tourniquet"] as const;
const LAST = LINES.length;
const STEP_MS = 1500;

export function ClaraBoxDemo() {
  const [step, setStep] = useState(1);
  const timers = useRef<number[]>([]);

  const clear = useCallback(() => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  }, []);

  const play = useCallback(() => {
    clear();
    let reduce = false;
    try {
      reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      reduce = false;
    }
    if (reduce) {
      setStep(LAST);
      return;
    }
    setStep(1);
    for (let s = 2; s <= LAST; s++) timers.current.push(window.setTimeout(() => setStep(s), STEP_MS * (s - 1)));
  }, [clear]);

  useEffect(() => {
    play();
    return clear;
  }, [play, clear]);

  const shown = LINES.slice(0, step);
  const lit = step >= 2;

  return (
    <figure className="cbox" aria-label="A Clara box guiding someone through treating a bleeding arm">
      <span className="cbox-screw" data-pos="tl" aria-hidden="true" />
      <span className="cbox-screw" data-pos="tr" aria-hidden="true" />
      <span className="cbox-screw" data-pos="bl" aria-hidden="true" />
      <span className="cbox-screw" data-pos="br" aria-hidden="true" />

      <div className="cbox-head">
        <span className="cbox-name">CLARA</span>
        <span className="cbox-tag">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true" focusable="false">
            <path d="M12 2v6M12 16v6M2 12h6M16 12h6" />
          </svg>
          First aid
        </span>
      </div>

      <ol className="cbox-screen" aria-live="polite">
        {shown.map((l, i) => (
          <li key={i} className="cbox-line" data-tone={l.tone} data-old={i < shown.length - 1 || undefined}>
            <span className="cbox-who">{l.who}</span>
            <span className="cbox-text">{l.text}</span>
          </li>
        ))}
      </ol>

      <ul className="cbox-slots" aria-label="Compartments">
        {SLOTS.map((name) => {
          const on = lit && name === "Gauze";
          return (
            <li key={name} className="cbox-slot" data-on={on || undefined}>
              <span className="cbox-slot-name">{name}</span>
              <span className="cbox-slot-state">{on ? "Open this one" : "Closed"}</span>
            </li>
          );
        })}
      </ul>

      <button type="button" className="cbox-replay" onClick={play}>
        Play again
      </button>
    </figure>
  );
}
