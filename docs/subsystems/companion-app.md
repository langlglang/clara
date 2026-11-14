# Companion app handoff — proposed

The app's demo job is to show a small set of fictional box locations. Show site address, floor/landmark, accessibility and availability. Phone location is optional; a search by address must work without it. Indoor GNSS on a box may be inaccurate, so the site record is primary.

An SOS action opens a **mock SOS** screen with the fictional site location. It never opens a real emergency dialer or sends a message.

The HackPrinceton app can also show a **mock nearby responder preview** after Mock SOS. Seed fictional volunteer profiles with CPR/AED training, opt-in, availability and a coarse fictional location. Show the number that *would* match and a simulated response timeline; do not request real users' location, send pushes or imply a trained person was contacted. This preview is optional to the SOS path and must not block it.

Later product concept: opted-in trained volunteers could receive a time-limited notification for an eligible public incident. A volunteer would accept in the app before exact incident location is shared, and could decline or go unavailable at any time. Training type, verification and expiry must be shown accurately. No real alerting is planned for the demo. See the [emergency workflow](emergency-workflow.md) for trigger, privacy and failure rules.

For the demo, the companion app may show a **fictional handoff card** beside the simulated accepted-responder state; no actual person receives it. In a later product, an accepted, authenticated SOS recipient could see a minimal, expiring handoff card after the initiator authorizes sharing. Keep user reports, tool observations and confirmed actions visually distinct. Do not expose the card to merely nearby accounts or in the initial push. Revocation or incident expiry removes access.

Use the [directory record and mock SOS states](../contracts.md). Acceptance: stale box availability is marked, location permission denial still permits search, duplicate taps keep one mock state/preview, offline preview uses fictional data, the fictional handoff card does not contain volunteer health data, and no screen claims help was contacted. No app feature is required to operate the box.
