# Kit inventory handoff — proposed

The screen can point to an item only if it knows the exact physical kit revision and a teammate has verified that box. Start with a fixed tray model `CL-DEMO-A`. Proposed top view: A1 gloves, A2 dressings, B1 gauze, B2 pressure dressing, C1 bandage, C2 spare/empty. This is a **sample demo layout**, not a finalized medical kit. The demo will never be used on a patient.

Each tray has permanent printed slot labels and a revision label. Each box has a manifest with SKU, slot, quantity, lot, expiry, verification date and checker identity. The screen holds a matching layout image. After a supply is used or the seal breaks, mark its availability unknown until a teammate checks it. A mismatched revision means no item-location claim.

Proposed addition: mount one LED beside each physical slot, not on the removable supply. Keep a `slot_id → led_channel` map with the same kit revision as the printed tray and screen asset. The Pi may light only a slot returned by a verified `inventory.locate` result for the active step; it clears the previous slot before lighting the next. If the manifest, layout or light map does not match the box, do not light a compartment. Printed slot labels and the screen diagram remain the location cues if a light fails. Photograph and check each slot-to-light mapping after assembly and whenever the tray or wiring changes.

## Running supply ledger (proposed; no weight or slot sensors)

Clara keeps a **running count** instead of sensing supplies. The rule: **the LLM turns what people say into structured entries; plain code keeps the count.** The LLM never edits a count directly.

1. **Starting stock.** At restock, a teammate records the quantity in each slot in the manifest (for example, "B2: 2 pressure dressings").
2. **Expected use during the session.** When the scenario reaches a step that uses an item, the box logs `supply.expected_use` (for example, the tourniquet step logs one tourniquet). This is deterministic, from the scenario file.
3. **End-of-session report.** When the guide ends or the lid closes after a session, the box asks "What did you use?" Online, Claude turns the answer ("both gauze rolls and some gloves") into an `inventory.record_usage` tool call. Each `sku` must exist in the active manifest and each `qty` must be between 1 and the quantity on hand. Offline, or if speech fails, the box shows the tray with +/- counters prefilled from the expected use.
4. **Confirmation.** The screen shows the proposed list ("Used: 2 gauze, 1 pair of gloves. Correct?") with +/- controls. Only a tap on **Confirm** writes `supply.usage_confirmed`. If nobody confirms, the proposed use is stored as `supply.usage_unconfirmed` and the affected slots become **unverified**.
5. **Ledger.** Stock per slot = starting quantity − confirmed use. Unverified slots are shown as "unverified" until the next restock check resets them. The agent and `inventory.locate` never claim an unverified item is present.
6. **Restock.** When a slot reaches its low threshold, the box's heartbeat reports `low_supplies` and the hub shows a restock alert. The hub keeps supply use per box over time for supply planning.

This replaces per-slot scanning during sessions; a teammate still verifies the tray at restock. A missing high-value item reported with no emergency session feeds the [anti-theft](anti-theft.md) flag.

Use [manifest and supply contracts](../contracts.md). Acceptance: scanning a wrong revision blocks map and light; a missing item is never described as present; expired supply is flagged; each screen/LED slot callout matches the physical tray in a photographed check; an LLM-proposed usage with an unknown SKU or a quantity above stock is rejected; nothing changes the count without a confirm tap; an unconfirmed session leaves the affected slots unverified; offline sessions can record use by +/- counters. Assign one teammate to reset the demo tray between runs.
