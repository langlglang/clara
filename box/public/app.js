// Clara box screen. Draws the ScreenView the box service streams (Server-Sent Events) and posts SOS presses.
// Pattern from Sophi's walker screen (github.com/mzhao1599/sophi, devices/pi/src/screen/page.tsx), without React.
(() => {
  "use strict";
  const token = document.querySelector('meta[name="screen-token"]').getAttribute("content");
  const $ = (id) => document.getElementById(id);
  let view = null;
  let linkOk = false;
  let wakeUntil = 0;

  function press(body) {
    fetch("/screen/press", {
      method: "POST",
      headers: { "content-type": "application/json", "x-screen-token": token },
      body: JSON.stringify(body),
    }).catch(() => {});
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const body = { action: button.dataset.action };
    if (button.dataset.step) body.step_id = button.dataset.step;
    if (button.dataset.incident) body.incident_id = button.dataset.incident;
    press(body);
  });

  const show = (el, on) => {
    el.hidden = !on;
  };
  const text = (el, value) => {
    el.textContent = value == null ? "" : String(value);
  };
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const timeOfDay = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  const upper = (value) => String(value).toUpperCase();
  const voiceLabels = {
    off: "MIC OFF",
    starting: "STARTING MIC",
    ready: "READY TO TALK",
    listening: "LISTENING",
    processing: "PROCESSING",
    speaking: "SPEAKING",
    unavailable: "VOICE UNAVAILABLE",
  };

  // The help-status strip, from the who-is-coming line (comingLine() in @clara/contracts, a fixed template):
  // "Priya is coming, about 3 minutes. 1 more person is coming too." -> "PRIYA COMING · 3 MIN · +1 MORE".
  // Anything that doesn't match the template is shown as said, so nothing is ever invented here.
  function comingStrip(line) {
    const here = /^(.+) is here\.$/.exec(line);
    if (here) return { text: `${upper(here[1])} IS HERE`, here: true };
    const coming = /^(.+?) is coming(?:, about (\d+) minutes?)?\.(?: (\d+) more (?:person is|people are) coming too\.)?$/.exec(line);
    if (!coming) return { text: upper(line), here: false };
    const parts = [`${upper(coming[1])} COMING`];
    if (coming[2]) parts.push(`${coming[2]} MIN`);
    if (coming[3]) parts.push(`+${coming[3]} MORE`);
    return { text: parts.join(" · "), here: false };
  }

  // 2x2 stat tiles (label, big mono number, small line), only for what the view really has.
  function tile(label, value, sub, tone) {
    const el = document.createElement("div");
    el.className = `tile${tone ? ` ${tone}` : ""}`;
    const l = document.createElement("span");
    l.className = "lbl";
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "v";
    v.textContent = value;
    el.append(l, v);
    if (sub) {
      const s = document.createElement("span");
      s.className = "s";
      s.textContent = sub;
      el.append(s);
    }
    return el;
  }

  function drawTimers() {
    if (!view) return;
    const now = Date.now();
    const tiles = [];
    for (const t of view.timers) {
      if (t.timer === "tourniquet") tiles.push(tile("TQ ON", timeOfDay(t.started_at), `${clock(now - t.started_at)} AGO`, "hot"));
      else if (t.timer === "pressure") tiles.push(tile("PRESSURE", clock(now - t.started_at), "HOLDING", "hot"));
      else tiles.push(tile(upper(t.timer), clock(now - t.started_at), null, null));
    }
    if (view.sos) tiles.push(tile("911 SIM", clock(now - view.sos.opened_at), "MOCK CALL OPEN", null));
    if (view.coming) {
      const strip = comingStrip(view.coming);
      const min = /\b(\d+) MIN\b/.exec(strip.text);
      if (strip.here) tiles.push(tile("HELPER", "HERE", null, "ok"));
      else if (min) tiles.push(tile("HELP ETA", `${min[1]} MIN`, null, "info"));
    }
    if (view.multiple_injured) tiles.push(tile("INJURED", "2+", "MULTIPLE", "hot"));
    $("tiles").replaceChildren(...tiles.slice(0, 4));
    if (view.sos) text($("call-time"), `OPEN ${clock(now - view.sos.opened_at)}`);
  }

  function draw() {
    if (!view) return;
    const v = view;
    if (v.lid_open) wakeUntil = 0;
    show($("sleep"), !v.lid_open && !v.sos && !v.countdown && Date.now() >= wakeUntil);
    const voiceState = !v.lid_open ? "off" : voiceLabels[v.voice_state] ? v.voice_state : "unavailable";
    text($("voice-state"), voiceLabels[voiceState]);
    $("voice-state").className = `tag ${voiceState}`;
    show($("idle-activity"), v.lid_open);
    $("idle-activity").className = `voice-activity ${voiceState}`;
    text($("activity-text"), voiceLabels[voiceState]);
    $("status").classList.toggle("offline", !v.online);
    text($("status-text"), v.online ? "ONLINE" : "OFFLINE · SOS AVAILABLE");
    show($("tag-link"), !linkOk);

    show($("coming"), Boolean(v.coming));
    if (v.coming) {
      const strip = comingStrip(v.coming);
      text($("coming-text"), strip.text);
      $("coming").classList.toggle("here", strip.here);
    }

    show($("notice"), Boolean(v.notice));
    text($("notice-text"), v.notice);

    const p = v.presentation || (v.step ? {
      title: v.step.label, body: v.step.text, image_url: v.step.image_url, item: v.step.item, source_label: null,
    } : null);
    show($("idle"), !p);
    show($("presentation"), Boolean(p));
    text($("idle-instruction"), v.lid_open ? "" : "Open the lid to speak with Clara. The microphone is off while closed.");
    text($("idle-caption"), v.caption);
    if (p) {
      text($("visual-title"), p.title);
      text($("visual-body"), p.body);
      text($("visual-source"), p.source_label);
      $("visual-body").classList.toggle("long", p.body.length > 110);
      const img = $("visual-image");
      if (p.image_url) {
        if (img.getAttribute("src") !== p.image_url) img.setAttribute("src", p.image_url);
        img.alt = p.kind === "diagram" || p.kind === "guidance" ? p.body : p.title;
        show(img, true);
        show($("no-image"), false);
      } else {
        img.removeAttribute("src");
        img.alt = "";
        show(img, false);
        show($("no-image"), true);
      }
      $("presentation").classList.toggle("no-pic", !p.image_url);
      $("presentation").classList.toggle("hero-visual", Boolean(p.image_url && (p.kind === "diagram" || (p.kind === "guidance" && p.image_url.startsWith("/content/visuals/")) || (p.item && p.image_url.startsWith("/content/kits/layout-3slot-v1-")))));
      // Compartment callout only when the presentation names an item.
      const item = $("item");
      show(item, Boolean(p.item));
      item.className = "";
      if (p.item) {
        const name = p.item.name || p.item.sku;
        text($("slot"), p.item.slot);
        if (p.item.missing) {
          item.className = "missing";
          text($("item-text"), name);
          text($("item-state"), "NOT IN THIS BOX");
        } else {
          item.className = p.item.lit ? "lit" : "";
          text($("item-text"), p.item.slot ? `COMPARTMENT ${p.item.slot} · ${name}` : name);
          text($("item-state"), p.item.lit ? "LED CUE" : "");
        }
      }
      text($("caption"), v.caption && v.caption !== p.body ? v.caption : "");
    }
    $("sos-button").classList.toggle("open", Boolean(v.sos));
    const mute = $("mute-button");
    mute.dataset.action = v.speech_muted ? "unmute" : "mute";
    mute.textContent = v.speech_muted ? "UNMUTE CLARA" : "MUTE CLARA";
    mute.setAttribute("aria-pressed", String(v.speech_muted));
    mute.classList.toggle("active", v.speech_muted);
    // report_url stays in the view model but is not drawn: the team dropped QR codes.

    show($("countdown"), v.phase === "countdown");
    if (v.countdown) text($("countdown-number"), v.countdown.seconds_left);

    show($("call"), v.phase === "sos");
    if (v.sos) {
      $("coaching").replaceChildren(
        ...v.sos.coaching.map((line) => {
          const li = document.createElement("li");
          li.textContent = line;
          return li;
        }),
      );
      text($("call-network"), v.online ? "Alert queued for the response network." : "Offline: the response network is not notified yet. It is sent when the link returns.");
      text($("call-coming"), v.coming ? comingStrip(v.coming).text : "NOBODY HAS ACCEPTED YET");
      $("call-coming").classList.toggle("none", !v.coming);
    }

    drawTimers();
  }

  function connect() {
    const source = new EventSource(`/screen/events?token=${encodeURIComponent(token)}`);
    source.addEventListener("open", () => {
      linkOk = true;
      draw();
    });
    source.addEventListener("view", (event) => {
      linkOk = true;
      try {
        const incoming = JSON.parse(event.data);
        if (!/^screen-view\/1\.\d+$/.test(incoming.schema_version)) {
          text($("tag-link"), "SCREEN VERSION MISMATCH");
          show($("tag-link"), true);
          return;
        }
        view = incoming;
      } catch {
        return;
      }
      draw();
    });
    source.addEventListener("error", () => {
      linkOk = false;
      draw();
      source.close();
      // 403 means the service restarted with a new token: reload. Anything else: reconnect.
      fetch(`/screen/check?token=${encodeURIComponent(token)}`)
        .then((r) => (r.status === 403 ? location.reload() : setTimeout(connect, 1000)))
        .catch(() => setTimeout(connect, 2000));
    });
  }

  // A picture that fails to load shows the placeholder instead of a broken image.
  $("visual-image").addEventListener("error", () => {
    show($("visual-image"), false);
    show($("no-image"), true);
  });

  const wakeScreen = () => {
    wakeUntil = Date.now() + 15_000;
    draw();
    setTimeout(draw, 15_000);
  };
  $("sleep").addEventListener("pointerdown", wakeScreen);
  $("sleep").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      wakeScreen();
    }
  });

  setInterval(drawTimers, 1000);
  connect();
})();
