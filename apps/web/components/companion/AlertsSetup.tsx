"use client";

import { useEffect, useState } from "react";
import { ApiError, api, postJson } from "../../lib/client";
import { currentSubscription, disablePush, enablePush, isIos, isStandalone, permission, pushSupported } from "../../lib/pushClient";

/**
 * Alerts on this device: notification permission and push subscription, a test alert, and consent to a phone
 * call as a backup (only offered when there's a phone number). Buttons here are secondary; the screen's own
 * primary button stays the one orange button.
 */
export function AlertsSetup({ volunteerId, hasPhone, callConsent, onConsent }: { volunteerId: string; hasPhone: boolean; callConsent: boolean; onConsent(value: boolean): Promise<void> | void }) {
  const [state, setState] = useState<"checking" | "unsupported" | "ios-browser" | "off" | "denied" | "on">("checking");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!pushSupported()) return live && setState(isIos() && !isStandalone() ? "ios-browser" : "unsupported");
      if (permission() === "denied") return live && setState("denied");
      const sub = await currentSubscription().catch(() => null);
      if (!live) return;
      if (sub && permission() === "granted") {
        // Make sure the server knows this device (it keeps subscriptions in memory and may have restarted).
        await api(`/api/volunteers/${encodeURIComponent(volunteerId)}/push`, { method: "POST", body: JSON.stringify({ subscription: sub.toJSON() }) }).catch(() => undefined);
        setState("on");
      } else setState("off");
    })();
    return () => {
      live = false;
    };
  }, [volunteerId]);

  async function turnOn() {
    setBusy("on");
    setMsg(null);
    const r = await enablePush(volunteerId);
    setBusy(null);
    if (r.result === "ok") {
      setState("on");
      setMsg({ text: "Alerts are on for this device.", tone: "ok" });
    } else if (r.result === "denied") {
      setState("denied");
    } else if (r.result === "unsupported") {
      setState(isIos() && !isStandalone() ? "ios-browser" : "unsupported");
    } else setMsg({ text: r.message ?? "Couldn't turn on alerts.", tone: "error" });
  }

  async function turnOff() {
    setBusy("off");
    await disablePush(volunteerId);
    setBusy(null);
    setState("off");
    setMsg({ text: "Alerts are off for this device. They still appear in the app while it's open.", tone: "ok" });
  }

  async function test() {
    setBusy("test");
    setMsg(null);
    try {
      const r = await postJson<{ sent: number; failed: number; removed: number }>(`/api/volunteers/${encodeURIComponent(volunteerId)}/push/test`);
      setMsg(r.sent > 0 ? { text: "Test sent. It should arrive in a few seconds, even with Clara closed.", tone: "ok" } : { text: "The test didn't reach this device. Turn alerts off and on again.", tone: "error" });
      if (r.removed > 0 && r.sent === 0) setState("off");
    } catch (e) {
      setMsg({ text: e instanceof ApiError ? e.message : "Couldn't send a test.", tone: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="card">
        <span className="lbl">This device</span>
        {state === "checking" ? <span className="muted">Checking…</span> : null}
        {state === "on" ? <b className="t-green">Alerts on: a loud notification with I&apos;M COMING / CAN&apos;T buttons.</b> : null}
        {state === "off" ? <span>Alerts are off. Turn them on so an emergency reaches you with Clara closed.</span> : null}
        {state === "denied" ? (
          <span className="t-amber">Notifications are blocked for this site. Allow them in your browser or phone settings (Site settings → Notifications), then come back.</span>
        ) : null}
        {state === "ios-browser" ? (
          <span className="t-amber">On iPhone, alerts work only after you add Clara to your Home Screen (next step) and open it from there (iOS 16.4 or later). Then turn alerts on in Profile.</span>
        ) : null}
        {state === "unsupported" ? <span className="t-amber">This browser can&apos;t receive push alerts. Keep Clara open, or try Chrome on Android or a home-screen app on iPhone.</span> : null}
        {state === "off" ? (
          <button type="button" className="btn block" aria-disabled={busy !== null || undefined} onClick={() => void turnOn()}>
            {busy === "on" ? "Asking…" : "Turn on alerts"}
          </button>
        ) : null}
        {state === "on" ? (
          <div className="row" style={{ flexWrap: "wrap" }}>
            <button type="button" className="btn grow" aria-disabled={busy !== null || undefined} onClick={() => void test()}>
              {busy === "test" ? "Sending…" : "Send me a test alert"}
            </button>
            <button type="button" className="btn ghost" aria-disabled={busy !== null || undefined} onClick={() => void turnOff()}>
              Turn off
            </button>
          </div>
        ) : null}
        {msg ? (
          <p className={msg.tone === "ok" ? "small t-green" : "error"} role={msg.tone === "error" ? "alert" : "status"}>
            {msg.text}
          </p>
        ) : null}
      </div>
      {hasPhone ? (
        <div className="card">
          <label className="row" style={{ alignItems: "flex-start", gap: 12, minHeight: 44 }}>
            <input
              type="checkbox"
              checked={callConsent}
              disabled={busy === "consent"}
              onChange={async (e) => {
                setBusy("consent");
                try {
                  await onConsent(e.target.checked);
                } finally {
                  setBusy(null);
                }
              }}
              style={{ width: 24, height: 24, marginTop: 2, accentColor: "var(--accent)", flex: "none" }}
            />
            <span>
              <b>Call me if I miss an alert</b>
              <span className="small muted" style={{ display: "block" }}>
                If an alert is still unseen after 30 seconds, Clara phones you once: press 1 if you can come, 2 if you can&apos;t. At most a few calls an hour, never in
                quiet hours. Clara never calls emergency services for you.
              </span>
            </span>
          </label>
        </div>
      ) : (
        <p className="small muted">Add a phone number in your profile if you&apos;d like a phone call as a backup.</p>
      )}
    </div>
  );
}
