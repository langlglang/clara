// Clara box screen. Draws the ScreenView the box service streams (Server-Sent Events) and posts presses.
// Pattern from Sophi's walker screen (github.com/mzhao1599/sophi, devices/pi/src/screen/page.tsx), without React.
(() => {
  "use strict";
  const token = document.querySelector('meta[name="screen-token"]').getAttribute("content");
  const $ = (id) => document.getElementById(id);
  let view = null;
  let linkOk = false;

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
    text($("box-name"), v.box_name);
    show($("tag-sim"), v.simulated);
    $("status").classList.toggle("offline", !v.online);
    text($("status-text"), v.online ? "ONLINE" : "OFFLINE · STEPS STILL WORK");
    show($("tag-link"), !linkOk);

    show($("coming"), Boolean(v.coming));
    if (v.coming) {
      const strip = comingStrip(v.coming);
      text($("coming-text"), strip.text);
      $("coming").classList.toggle("here", strip.here);
    }

    const busy = v.phase !== "idle";
    const firstNearby = v.nearby[0];
    show($("nearby-banner"), busy && Boolean(firstNearby));
    if (firstNearby) text($("nearby-banner-text"), `${firstNearby.from_box_name}: ${firstNearby.directions}`);

    show($("notice"), Boolean(v.notice));
    text($("notice-text"), v.notice);

    show($("idle"), !v.step);
    show($("guide"), Boolean(v.step));
    if (v.step) {
      const s = v.step;
      text($("step-label"), s.label);
      text($("step-text"), s.text);
      // Long steps, or steps with branch buttons, get a smaller size so everything fits 800x480 unscrolled.
      $("step-text").classList.toggle("long", s.text.length > 110 || (s.options.length > 1 && s.text.length > 70));
      const img = $("step-image");
      if (s.image_url) {
        if (img.getAttribute("src") !== s.image_url) img.setAttribute("src", s.image_url);
        show(img, true);
        show($("no-image"), false);
      } else {
        img.removeAttribute("src");
        show(img, false);
        show($("no-image"), true);
      }
      $("guide").classList.toggle("no-pic", !s.image_url);
      // Compartment callout: "COMPARTMENT B1 · TOURNIQUET", the slot drawn lit when the box lit it.
      const item = $("item");
      show(item, Boolean(s.item));
      item.className = "";
      if (s.item) {
        const name = s.item.name || s.item.sku;
        text($("slot"), s.item.slot);
        if (s.item.missing) {
          item.className = "missing";
          text($("item-text"), name);
          text($("item-state"), "NOT IN THIS BOX");
        } else {
          item.className = s.item.lit ? "lit" : "";
          text($("item-text"), s.item.slot ? `COMPARTMENT ${s.item.slot} · ${name}` : name);
          text($("item-state"), s.item.lit ? "LIT" : "");
        }
      }
      const options = $("options");
      options.replaceChildren(
        ...s.options.map((o) => {
          const b = document.createElement("button");
          b.dataset.action = "goto";
          b.dataset.step = o.step_id;
          b.textContent = o.label;
          return b;
        }),
      );
      text($("caption"), v.caption && v.caption !== s.text ? v.caption : "");
      $("back-button").disabled = !s.can_back;
      $("next-button").disabled = !s.can_next;
      $("repeat-button").disabled = false;
    } else {
      $("back-button").disabled = true;
      $("repeat-button").disabled = true;
      $("next-button").disabled = true;
    }
    $("talk-button").classList.toggle("off", !v.voice_available);
    $("multi-button").classList.toggle("on", v.multiple_injured);
    $("sos-button").classList.toggle("open", Boolean(v.sos));
    // report_url stays in the view model but is not drawn: the team dropped QR codes.

    show($("usage"), Boolean(v.pending_usage) && v.phase === "guiding");
    if (v.pending_usage) {
      $("usage-list").replaceChildren(
        ...v.pending_usage.map((u) => {
          const li = document.createElement("li");
          li.textContent = `${u.qty} × ${u.name}`;
          return li;
        }),
      );
    }

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

    // Idle box: another box's emergency takes the whole screen.
    show($("nearby-card"), !busy && Boolean(firstNearby));
    if (firstNearby) {
      text($("nearby-title"), `${firstNearby.from_box_name}: bring this kit`);
      text($("nearby-directions"), firstNearby.directions);
      text($("nearby-note"), firstNearby.bringing ? "Noted on this box (not confirmed to the other box)." : "");
      $("bringing-button").dataset.action = "bringing_kit";
      $("bringing-button").dataset.incident = firstNearby.incident_id;
      $("nearby-dismiss").dataset.action = "dismiss_nearby";
      $("nearby-dismiss").dataset.incident = firstNearby.incident_id;
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
        view = JSON.parse(event.data);
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
  $("step-image").addEventListener("error", () => {
    show($("step-image"), false);
    show($("no-image"), true);
  });

  setInterval(drawTimers, 1000);
  connect();
})();
