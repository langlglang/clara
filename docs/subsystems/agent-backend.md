# Agent and backend handoff — proposed

Keep a cloud worker warm so lid opening starts a session quickly. The backend authenticates the box, checks consent, gives the agent a small set of typed tools, and serves versioned source-linked demo packages. The agent can ask a short question, request an item location, or ask for a consented camera frame; policy code checks each action. A model answer alone cannot become an instruction.

The agent keeps current session facts separate from long-lived protocol and inventory data. Every observation has a source and time. Tool failures are visible; a late result from a canceled turn is ignored. On network loss, the Pi cancels the cloud turn and uses its cached guide. Keep raw audio/frames transient by default.

When someone arrives, `handoff.prepare` may draft a short card from the current session event log. A validator keeps only source-linked facts, observed times, uncertainty and actual shown/acknowledged step IDs. The Pi can build a minimal card locally if the cloud is unavailable. The agent does not send responder alerts or publish a handoff to a remote account; a later alert service would handle that after explicit SOS, acceptance and sharing authority.

Implement the [runtime blueprint](../agent-runtime.md) and [event contracts](../contracts.md). Acceptance: actual call traces for match/next-step/inventory/handoff, synchronized step package, interrupt/cancel race, offline fallback, stale sensor, uncertain camera, immediate mock SOS, and a handoff card with no unsupported fact or claimed real alert. Scenario text follows the [demo content check](../medical-safety.md).
