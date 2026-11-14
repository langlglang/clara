# Companion app as a PWA: onboarding, push alerts, drivers, phone-call fallback

The volunteer app (`/app`, sign-up at `/join`) is a Progressive Web App. It installs to the home screen, opens on a weak connection, gets loud push alerts with answer buttons, and falls back to a phone call (Twilio) when an alert goes unseen. HackPrinceton demo: Clara never replaces emergency services and never calls them.

## Onboarding (`/join`)

One question per screen, designed at 390 px (Field Kit: charcoal, one orange button per step, progress bar, Back):

1. **Welcome**: what Clara is, what we'll ask, demo / not an emergency service.
2. **How can you help?** Give first aid nearby / Drive people to hospital (I have a car) / Both.
3. **Name and phone** (phone optional, E.164, needed only for call backup).
4. **First-aid skills** (first aid only): Stop the Bleed, CPR, first aid, nurse, doctor, EMT, midwife, marked *self-reported, not verified*.
5. **Vehicle and languages**: drivers pick car / van / motorbike, free seats, and optionally "someone lying down" / "a wheelchair".
6. **Where you usually are** (home for drivers): browser GPS or a tap on the Leaflet map, alert radius slider 0.5–10 km (default 2 km). Warns when no demo box is inside the radius.
7. **Availability**: available now, "usually free" note (e.g. "usually home evenings"), optional quiet hours.
8. **Alerts**: turn on notifications (subscribes this device), "Send me a test alert", and, with a phone number, "Call me if I miss an alert".
9. **Install**: Chrome/Edge/Android get an "Install Clara" button (`beforeinstallprompt`); iPhone Safari gets Share → Add to Home Screen steps.

The volunteer is created when leaving step 7 (so step 8 can subscribe); going Back afterwards edits the same volunteer. The id stays in `localStorage` (`clara.volunteer_id`). `/app` sends anyone without an id to `/join`. The **Profile** tab edits every answer (one PATCH) and manages alerts on the device.

A driver who isn't medical gets only the `driver` skill: the network never matches `driver` alone to a first-aid alert, so they see ride offers only.

## PWA pieces

| File | What |
| --- | --- |
| `apps/web/app/manifest.ts` | name/short_name "Clara", `start_url` `/app`, standalone, Field Kit colors |
| `apps/web/app/icon.tsx`, `apple-icon.tsx`, `app/icons/[file]/route.tsx`, `lib/mark.tsx` | Orange cross on charcoal drawn with `ImageResponse` at build time (32, 180, 192, 512, maskable 512) |
| `apps/web/public/sw.js` | Service worker: app-shell cache (never `/api/*`), `push`, `notificationclick` |
| `apps/web/next.config.ts` | `/sw.js` served `no-cache` with a strict CSP; at the root, so scope `/` needs no `Service-Worker-Allowed` |
| `apps/web/lib/pushClient.ts` | Registration, permission, subscribe/unsubscribe, install prompt, iOS detection |

Notification buttons: alerts get **I'M COMING / CAN'T** (POST `/api/alerts/{id}/respond`), ride offers get **I CAN DRIVE / CAN'T** (POST `/api/rides/{id}/answer`). A plain tap opens `/app?alert=…` or `/app?ride=…`.

## Push (server)

- `lib/push.ts`: subscriptions in memory, keyed by volunteer id, up to 5 devices each. Every send has an 8 s deadline; a 404/410 drops the subscription.
- VAPID keys from `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`. Without them the server generates a pair at start, logs that, and keeps it in memory; subscriptions are in memory too, so both reset together on a restart and phones re-subscribe (the app does this on open).
- `lib/notify.ts`: the runtime listens to the network; every alert created in state `sent` (first wave, escalation, coordinator extras) is pushed: **EMERGENCY NEARBY** · "Severe bleeding · Clinic tent · 300 m (about 4 min). Can you come?" with `{ alert_id, volunteer_id, incident_id }`. Every new ride offer is pushed: **RIDE NEEDED** · "Clinic tent → District Hospital (fictional) · 1 seat · 1.0 km from you. Can you drive?". No patient names; nothing says help is already there. Quiet hours skip the push (the alert still waits in the app).

Routes: `GET /api/push/key`, `POST|DELETE /api/volunteers/[id]/push`, `POST /api/volunteers/[id]/push/test`, `GET|PATCH /api/volunteers/[id]`.

## Phone-call fallback (Twilio)

`lib/calls.ts`, driven by the runtime's 1 s tick:

- An alert still `sent` (never shown in the app, unanswered) **30 s** after it went out, or a ride offer still open and never shown in the driver's app 30 s after it went out, gets **one** call, only when the volunteer has an E.164 number **and** agreed to calls, isn't in quiet hours, and has had fewer than 3 calls in the last hour.
- Without `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_FROM_NUMBER` it only logs `would call +1******0199`; the maintainer console shows **Calls: not configured** and the recent call log.
- The call (`POST …/Calls.json` with inline TwiML) says: "This is Clara, a first-aid network demo. There is an emergency near you: severe bleeding at Clinic tent, about 300 meters away. Press 1 if you can come. Press 2 if you can't." (rides: "…press 1 if you can drive"), repeats once, then hangs up. A ride offer gets 60 s more while the phone rings.
- `POST /api/twilio/gather?alert=…&volunteer=…` maps 1 → coming, 2 → declined through `network.respond`; `?ride=…&driver=…` maps 1 → accept, 2 → decline through `rides.answer`. It checks `X-Twilio-Signature` (HMAC-SHA1 with the auth token over `PUBLIC_BASE_URL` + path + query, then the sorted POST params) and answers 403 otherwise.

**Twilio trial accounts can only call numbers you have verified in the Twilio console**, and they play a trial notice before the message. Buy a number with voice capability for `TWILIO_FROM_NUMBER`.

## Drivers and rides (`apps/web/lib/rides.ts`)

- Each ride goes to the nearest of three fictional hospitals (`DEMO_HOSPITALS`); the offer shows pickup (the box) → hospital, distance and drive time, and seats needed (`seats_needed`, default 1; drivers with fewer seats are "not suitable").
- Offers record `seen_at` when the driver's app shows them (the call fallback only calls unseen offers).
- After accepting, the driver reports **Patient in car** → **Arrived at hospital** (`trip`: `to_pickup` → `patient_in_car` → `at_hospital`, forward only, winner only; `POST /api/rides/[id]/progress`).
- Dispatch lists every free driver by distance; the console maps drivers as square markers with their seat count, with "lying down" / "wheelchair" / availability notes.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | generated in memory | `npx web-push generate-vapid-keys` once, then set both |
| `VAPID_SUBJECT` | `mailto:clara-demo@example.com` | a `mailto:` you read |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | unset (calls logged only) | all three needed |
| `PUBLIC_BASE_URL` | `https://clara.living` | origin Twilio calls back on |

## What only a real phone shows

- Push delivery, vibration, `requireInteraction`, and the action buttons (the desktop app's browser pane can't register service workers).
- iPhone: push works only from the home-screen app on iOS 16.4+; action buttons may not show on iOS (a tap opens the app).
- The install prompt (Android Chrome) and Add to Home Screen (iPhone).
- Real Twilio calls and key presses.
- GPS accuracy indoors.
