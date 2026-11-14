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
    if (button.dataset.scenario) body.scenario_id = button.dataset.scenario;
    if (button.dataset.language) body.language = button.dataset.language;
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

  // Screen words in Spanish (draft: to be checked by a fluent speaker). Clara's own words come translated from the box.
  const ES = {
    "CALL FOR HELP": "PEDIR AYUDA",
    "NEARBY EMERGENCY": "EMERGENCIA CERCANA",
    DISMISS: "DESCARTAR",
    "I'M BRINGING IT": "YO LO LLEVO",
    DONE: "HECHO",
    "STOP CPR COACH": "PARAR GUÍA DE RCP",
    "NO PULSE DETECTED BY THE SENSOR": "EL SENSOR NO DETECTA PULSO",
    "Is the person responding? Are they breathing normally?": "¿La persona responde? ¿Respira con normalidad?",
    "NOT BREATHING": "NO RESPIRA",
    BREATHING: "RESPIRA",
  };
  let lang = "en";
  const tr = (en, es) => (lang === "es" ? es : en);
  function applyLanguage(next) {
    if (next === lang) return;
    lang = next;
    document.documentElement.lang = lang;
    for (const el of document.querySelectorAll("[data-i18n]")) {
      if (el.dataset.en === undefined) el.dataset.en = el.textContent;
      el.textContent = lang === "es" ? ES[el.dataset.en] ?? el.dataset.en : el.dataset.en;
    }
  }
  const voiceLabelsEs = {
    off: "MICRÓFONO APAGADO",
    starting: "INICIANDO MICRÓFONO",
    ready: "LISTA PARA HABLAR",
    listening: "ESCUCHANDO",
    processing: "PROCESANDO",
    speaking: "HABLANDO",
    unavailable: "VOZ NO DISPONIBLE",
  };
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
      if (t.timer === "tourniquet") tiles.push(tile(tr("TQ ON", "TORNIQUETE"), timeOfDay(t.started_at), tr(`${clock(now - t.started_at)} AGO`, `HACE ${clock(now - t.started_at)}`), "hot"));
      else if (t.timer === "pressure") tiles.push(tile(tr("PRESSURE", "PRESIÓN"), clock(now - t.started_at), tr("HOLDING", "MANTENIENDO"), "hot"));
      else tiles.push(tile(upper(t.timer), clock(now - t.started_at), null, null));
    }
    if (view.coming) {
      const strip = comingStrip(view.coming);
      const min = /\b(\d+) MIN\b/.exec(strip.text);
      if (strip.here) tiles.push(tile("HELPER", "HERE", null, "ok"));
      else if (min) tiles.push(tile("HELP ETA", `${min[1]} MIN`, null, "info"));
    }
    if (view.multiple_injured) tiles.push(tile("INJURED", "2+", "MULTIPLE", "hot"));
    $("tiles").replaceChildren(...tiles.slice(0, 4));
  }

  function draw() {
    if (!view) return;
    const v = view;
    if (v.lid_open) wakeUntil = 0;
    applyLanguage(v.language === "es" ? "es" : "en");
    const langButton = $("lang-button");
    const other = (v.languages || []).find((l) => l !== v.language);
    show(langButton, Boolean(other));
    if (other) {
      langButton.dataset.language = other;
      text(langButton, other === "es" ? "ESPAÑOL" : "ENGLISH");
    }
    const labels = lang === "es" ? voiceLabelsEs : voiceLabels;
    // Another box's emergency wakes this screen even with the lid closed ("bring this kit").
    const near = v.nearby && v.nearby.length ? v.nearby[v.nearby.length - 1] : null;
    show($("sleep"), !v.lid_open && !v.sos && !v.countdown && !near && Date.now() >= wakeUntil);
    // Full-screen until someone takes it; then a banner so the box can still be used on the way.
    show($("nearby"), Boolean(near && !near.bringing) && !v.sos && !v.countdown);
    show($("nearby-banner"), Boolean(near && near.bringing));
    if (near) {
      text($("nearby-title"), tr(`EMERGENCY AT ${upper(near.from_box_name)} · BRING THIS KIT`, `EMERGENCIA EN ${upper(near.from_box_name)} · LLEVA ESTE KIT`));
      text($("nearby-directions"), near.directions);
      text($("nearby-banner-text"), `${tr("BRING THIS KIT TO", "LLEVA ESTE KIT A")} ${upper(near.from_box_name)}${near.directions ? ` · ${near.directions}` : ""}`);
      for (const id of ["nearby-dismiss", "nearby-bring", "nearby-done"]) $(id).dataset.incident = near.incident_id;
    }
    const voiceState = !v.lid_open ? "off" : voiceLabels[v.voice_state] ? v.voice_state : "unavailable";
    text($("voice-state"), labels[voiceState]);
    $("voice-state").className = `tag ${voiceState}`;
    show($("idle-activity"), v.lid_open);
    $("idle-activity").className = `voice-activity ${voiceState}`;
    text($("activity-text"), labels[voiceState]);
    $("status").classList.toggle("offline", !v.online);
    text($("status-text"), v.online ? tr("ONLINE", "EN LÍNEA") : tr("OFFLINE · SOS AVAILABLE", "SIN CONEXIÓN · SOS DISPONIBLE"));
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
      title: v.step.label, body: v.step.text, image_url: v.step.image_url, video_url: v.step.video_url, item: v.step.item, source_label: null,
    } : null);
    show($("idle"), !p);
    show($("presentation"), Boolean(p));
    text($("idle-instruction"), v.lid_open ? "" : tr("Open the lid to speak with Clara. The microphone is off while closed.", "Abre la tapa para hablar con Clara. El micrófono está apagado mientras está cerrada."));
    text($("idle-caption"), v.caption);
    if (p) {
      text($("visual-title"), p.title);
      text($("visual-body"), p.body);
      text($("visual-source"), p.source_label);
      $("visual-body").classList.toggle("long", p.body.length > 110);
      const img = $("visual-image");
      // A step clip (silent, looping) takes the picture's place; if it can't play, the picture shows instead.
      const video = $("visual-video");
      const clip = p.video_url && !videoFailed.has(p.video_url) ? p.video_url : null;
      if (clip) {
        if (video.getAttribute("src") !== clip) {
          video.setAttribute("src", clip);
          video.play().catch(() => {});
        }
        video.setAttribute("aria-label", p.body);
        show(video, true);
      } else if (video.hasAttribute("src")) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        show(video, false);
      }
      if (clip) {
        img.removeAttribute("src");
        show(img, false);
        show($("no-image"), false);
      } else if (p.image_url) {
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
      $("presentation").classList.toggle("no-pic", !p.image_url && !clip);
      $("presentation").classList.toggle("hero-visual", Boolean(clip) || Boolean(p.image_url && (p.kind === "diagram" || (p.kind === "guidance" && p.image_url.startsWith("/content/visuals/")) || (p.item && p.image_url.startsWith("/content/kits/layout-3slot-v1-")))));
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
    mute.textContent = v.speech_muted ? tr("UNMUTE CLARA", "ACTIVAR VOZ") : tr("MUTE CLARA", "SILENCIAR CLARA");
    mute.setAttribute("aria-pressed", String(v.speech_muted));
    mute.classList.toggle("active", v.speech_muted);
    $("presentation").classList.toggle("handoff", Boolean(v.presentation && v.presentation.kind === "handoff"));
    show($("coach"), Boolean(v.coach));
    if (v.coach) {
      text($("coach-bpm"), `${v.coach.bpm} PER MINUTE · PUSH WITH THE BEAT`);
      $("coach-ring").style.animationDuration = `${60 / v.coach.bpm}s`;
    }
    show($("pulse-prompt"), Boolean(v.pulse_prompt));
    drawCoach();

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

  // A clip that can't play falls back to the step's picture (or the placeholder).
  const videoFailed = new Set();
  $("visual-video").addEventListener("error", () => {
    const src = $("visual-video").getAttribute("src");
    if (src) videoFailed.add(src);
    draw();
  });

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

  function drawCoach() {
    if (!view || !view.coach) return;
    const beats = Math.floor((Date.now() - view.coach.started_at) / (60000 / view.coach.bpm)) + 1;
    text($("coach-count"), Math.max(0, beats));
  }
  setInterval(drawCoach, 100);
  setInterval(drawTimers, 1000);
  connect();
})();
