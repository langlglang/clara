# Anti-theft handoff — proposed demo

**Status:** proposed; nothing is implemented. Clara will never be used on a patient. **Anti-theft never blocks emergency access: no locks, no codes, no login, and nothing that delays the Clara Demo screen or Mock SOS.** Its job is to discourage casual theft and tell the box's maintainer when something is wrong.

## Demo targets

### 1. Open chime and light
When the lid opens, the box plays a short chime and flashes its lights. This is a mild deterrent and it also draws attention, which helps in an emergency. It stops after a few seconds (proposed: 8 s) or sooner when someone:
- touches the screen,
- starts a scenario or speaks to the agent, or
- opens Mock SOS.

The chime never repeats during an active session and never covers spoken instructions. A box sticker says: *"Opening this box sounds a chime. Camera activates when opened."*

### 2. Open snapshot
On every lid open, the Pi captures **one frame** from the box camera and stores it **locally, encrypted**, tagged to that open event. It is a security record, not a care tool:
- It is never sent to the agent, used for guidance, shown in the handoff card, or included in a network alert.
- Only the maintainer role can view it, from the maintainer view.
- It is deleted automatically after a short retention period (proposed: 24 hours) unless that open is flagged (see below). A flagged snapshot is deleted when the maintainer resolves the flag.
- The sticker and the open screen disclose it. In the demo, the person opening the box is a consenting teammate or volunteer.

This is an **exception** to Clara's "camera off by default; single frame only with consent" rule, and the team must agree to it. See [privacy and security](../privacy-security.md).

### 3. Non-emergency open flag
When the lid closes, Clara checks whether the session had an emergency: a started scenario, an agent session, or Mock SOS. If it had none, the box asks: *"Was anything taken from the box?"* and shows the kit tray. The open is flagged for the maintainer when:
- the lid was open for longer than a short limit (proposed: 2 minutes) with no emergency, or
- the volunteer, or a later restock check, says a **high-value item** (the tourniquet or the box itself in the demo kit) is gone with no emergency session.

The flag appears in the maintainer view with the open time, duration, and snapshot. In the demo, an optional SMS to a **team test phone** is a team decision; it never goes to emergency services.

### 4. Mount-removal alert
A limit switch on the wall bracket tells the ESP32 when the box is lifted off its mount (`mount.removed` / `mount.restored`).
- **During an emergency session:** the box says *"Please return me to the 2nd floor elevator when you're done"* and starts a return timer (proposed: 2 hours; shortened for the demo). If the box is not back on its mount when the timer runs out, the maintainer is alerted.
- **With no emergency session:** the maintainer is alerted right away with the time and the open snapshot, if there is one.
- The box keeps working normally either way. Lifting it off the wall never stops the guide or Mock SOS.

The box runs on its internal battery, so removing it from the wall does not cut power. That battery path is still unverified; see [hardware and power](../hardware-power.md).

## Later concepts

| Concept | Why later |
| --- | --- |
| Accelerometer (for example MPU6050) to detect carrying or a pry attempt | Needs tuning so carrying the box to a patient is not flagged as theft |
| GPS location report after removal | The optional GT-U7 rarely gets a fix indoors; the verified site address stays the location source |
| Cellular module for alerts without Wi-Fi | Adds a SIM, power, and antenna design |
| Inventory history to spot slow theft | Needs per-slot sensing or reliable restock records over time |
| Tamper detection (screen removal, power cut, prying) | Needs extra sensors and enclosure design |

## Rules

- Anti-theft code runs in its own path. A failure (camera busy, no network, buzzer fault) never delays the Clara Demo screen, the guide, or Mock SOS.
- A flag is a prompt for a person to check, not an accusation. The maintainer view says "opened without an emergency," not "theft."
- Use no face recognition, identity matching, or continuous recording.
- Snapshots and flags are stored separately from session health data and are never written to ordinary logs.

Messages: `mount.removed`, `mount.restored`, `alarm.set.request`, `alarm.status`, `security.flag` in [contracts](../contracts.md).

## Acceptance

The lid opens straight to the Clara Demo screen with the chime playing. A touch, scenario start, or Mock SOS stops the chime within 250 ms. A snapshot failure does not change the open flow. An open with no emergency and a long duration produces exactly one flag. Lifting the box during a session starts the return timer, and returning it cancels the alert. Snapshots older than the retention period are gone from disk.
