# Privacy and security — proposed HackPrinceton demo

**Status:** policy design with a few demo controls implemented. The lid gates the Pi microphone, and mock SOS location stays local. A full consent, access, retention, and deletion system is **proposed**, not deployed. Clara will never be used on a patient. Use fictional scenarios and consenting adult volunteers only.

## Consent by data type

| Data | Default | Volunteer action | Demo purpose |
| --- | --- | --- | --- |
| Microphone | Off while the lid is closed | Opening the lid starts a demo voice session; the screen shows mic state. A dedicated mute/consent control is proposed. | Live transcription and response |
| Camera | Covered/off | Preview and capture one frame for a specific question | Visual tool demonstration |
| Box location | Local USB GNSS reading or configured address fallback | No outbound location use in the mock SOS path; any future upload needs separate consent | Show a source-labeled location in mock SOS coaching |
| Nearby responder preview | Fictional profiles and sites only | Open mock preview after mock SOS | Explain the proposed matching flow without notifying anyone |
| Handoff card | Fictional scenario facts; volunteer observations omitted by default | Show handoff on box; separate explicit consent for any volunteer observation | Inform a newly arrived helper in the demo |
| Sensor data | No read | Start the connected cuff or sensor measurement | Show a real hardware result |
| Analytics | No raw media or readings | Separate opt-in if added | Reliability metrics |
| Open snapshot (proposed, needs team agreement) | One frame on every lid open, stored locally and encrypted | Disclosed by box sticker and the open screen; no per-open consent | Security record for the maintainer; see [anti-theft](subsystems/anti-theft.md) |
| Box status and network alerts | Box ID, site, state, manifest-based supply summary, incident location and coarse need | None; contains no personal or health data | Network map, nearby box alerts, nearest-kit card |
| Security flags | Open time, duration, flag kind, reference to the local snapshot | None | Maintainer view |

The open snapshot is the **only** exception to "camera off unless the volunteer consents." It is a single frame, never continuous video, never sent to the agent, never used for guidance, and never included in a network alert or handoff card. Only the maintainer role can view it. It is deleted after a short retention period (proposed: 24 hours) unless its open is flagged; a flagged snapshot is deleted when the maintainer resolves the flag. No face recognition or identity matching is performed. If the team does not agree to this exception, drop the snapshot and keep the other anti-theft features.

No background audio or camera stream while the lid is shut. The current lid switch is the local mic gate; a dedicated mute and consent control is proposed. The overall interface says **Clara Demo**; a sensor value shows its device, unit and timestamp without a separate experimental badge.

## Access and data handling

Use a per-device identity and scoped session token. Give restockers only inventory access. Give the maintainer role access to box status, security flags and open snapshots, but not to session transcripts, guidance frames or sensor readings. Box-to-box network alerts are authenticated per device so one box cannot spoof another's incident. Treat speech, image text and tool results as untrusted input. Use TLS for cloud traffic and keep credentials out of logs. Do not ship a shared API key on a public repo or SD image.

Process frames, audio, transcripts, readings, and precise box GPS fixes in memory for the active demonstration. Do not store or export them by default. At session close, clear them from local and cloud memory. Retain only minimal operational logs with pseudonymous IDs and no raw media, transcript, reading or precise volunteer location. If a recording is needed for presentation, obtain separate explicit consent and document deletion. The Pi mock SOS coaching may show a fresh GPS fix locally; it does not send that fix to the cloud or volunteers. No real emergency call is made.

**Later responder network:** use separate opt-in for responder availability, location sharing and push notifications. Store only the training claim and verification evidence needed to select eligible responders, with an expiry and a way to withdraw/delete it. A match should use recent coarse location; exact incident location is released only to an accepted, authorized responder for an eligible public event. Do not include patient identity, camera/audio, sensor readings or transcripts in alerts. Expire incident access promptly and record who saw the location. Define retention, deletion, abuse handling and jurisdictional rules before any real alerts. These controls are not implemented for the HackPrinceton demo.

**Later context sharing:** a handoff card may disclose sensitive facts even without raw media. Require explicit sharing authority, identify the recipient, scope fields to what that person needs, and record access. A merely nearby candidate sees no card; an accepted and authenticated recipient gets a time-limited view. Revoke access on cancellation, expiry or user request. Keep observations with source/time and consent state; omit unconsented camera frames, audio, readings, patient identity and unsupported conclusions. The demo companion card contains fictional data only.

## Demo checks

Verify that closing or resetting a session stops capture, an unauthorized session cannot fetch another session's data, a denied permission causes a clear fallback, a failed sensor read does not leak the previous volunteer's result, open snapshots older than the retention period are gone from disk, a non-maintainer cannot fetch a snapshot, and no snapshot, transcript or reading appears in `box.status`, `network.alert` or `security.flag` payloads. Any idea to use Clara with patients or deploy it publicly is a separate project with its own privacy, legal, medical and security review.
