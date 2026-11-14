# Field Kit UI theme (chosen 2026-11-13)

**Status:** chosen look for every Clara screen: companion app (phone), network console and dispatch (computer), and the box screen. Mockups: [`mockups/field-kit-phone.html`](mockups/field-kit-phone.html) and [`mockups/field-kit-computer.html`](mockups/field-kit-computer.html) (design-canvas exports; open in a browser for reference, the `<x-dc>` wrapper is not app code). Live canvas: https://claude.ai/artifact/Qb94BTMDQ9Q6VZRybUKHsb (row "Field Kit").

**Exception (2026-11-14):** the landing page (`/`) and volunteer sign-up (`/join`) use the Signal theme instead, scoped with the `.theme-signal` class in `apps/web/app/globals.css`: black background, orange `#FF5A1F` with black text on orange buttons, Barlow Condensed headings, Barlow body text, IBM Plex Mono only for timestamps (`.time`). Reference mockups: `design-mockups/`. Every other screen stays Field Kit, and `/` keeps the shared Field Kit `TopBar` above the Signal content. The "How you help" tiles (First aid / Driving) are shared with Profile and use whichever theme they sit in.

Feel: rugged emergency equipment. Charcoal, one safety-orange action color, square corners, monospaced numbers and labels, high contrast.

## Tokens (use as CSS variables)

```css
:root {
  --bg: #18181B;        /* page */
  --surface: #27272A;   /* cards, sheets */
  --text: #FAFAFA;
  --muted: #A1A1AA;     /* secondary text, labels */
  --border: #3F3F46;
  --accent: #F97316;    /* safety orange: primary buttons, active, emergency */
  --on-accent: #18181B; /* text on orange */
  --ok: #22C55E;        /* ready, arrived, accepted */
  --warn: #EAB308;      /* low stock */
  --info: #38BDF8;      /* helpers on foot, on-the-way */
  --map: #1F1F23; --road: #2E2E33;
  --radius: 0px;        /* square everywhere */
  --font-head: 'IBM Plex Mono', monospace;   /* labels, numbers, buttons, headings */
  --font-body: 'IBM Plex Sans', sans-serif;  /* sentences */
}
```
Google Fonts: `IBM Plex Mono` 500/700, `IBM Plex Sans` 400/600/700.

## Rules
- Labels, buttons and key numbers: mono, uppercase, letter-spacing 0.08–0.12em.
- One orange primary button per screen (64px tall on phone), secondary = 1px border, transparent.
- Data in 2×2 stat tiles (label + big mono number), e.g. TQ ON 14:14 · PULSE 112 · ALERTED 3 · AMBULANCE 35+ MIN.
- Status colors: ready green, low stock yellow, emergency/in use orange, offline grey, helper blue.
- Touch targets ≥44px; text contrast ≥4.5:1 (all tokens above pass on --bg).
- Phone is designed at 390px wide, mobile-first. Computer screens at 1440px.

## Screens
**Phone (companion app):** 1 Home (available toggle, helpers/kits nearby, skills, last response) · 2 Incoming alert · 3 Map (helpers, kits, emergency, bottom sheet) · 4 On the way (ETA, what the box told the bystander, live scene timeline, message the box, I've arrived) · 5 Driver ride offer (pickup / hospital / ambulance times, accept within timer) · 6 Join the network (skills, vehicle + seats, alert radius).

**Computer:** Network and boxes (always-on live map of helpers and boxes, box status list, restock) · Dispatch and rides (emergencies, suggested driver with reasons, approve/reassign, backups, "said at the box").

**Box screen (5" 800×480):** same tokens; one step at a time, big orange SOS, compartment callout, help-status strip ("PRIYA COMING · 3 MIN").
