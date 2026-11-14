# Kit inventory handoff — proposed

The screen can point to an item only if it knows the exact physical kit revision and a teammate has verified that box. Start with a fixed tray model `CL-DEMO-A`. Proposed top view: A1 gloves, A2 dressings, B1 gauze, B2 pressure dressing, C1 bandage, C2 spare/empty. This is a **sample demo layout**, not a finalized medical kit. The demo will never be used on a patient.

Each tray has permanent printed slot labels and a revision label. Each box has a manifest with SKU, slot, quantity, lot, expiry, verification date and checker identity. The screen holds a matching layout image. After a supply is used or the seal breaks, mark its availability unknown until a teammate checks it. A mismatched revision means no item-location claim.

Proposed addition: mount one LED beside each physical slot, not on the removable supply. Keep a `slot_id → led_channel` map with the same kit revision as the printed tray and screen asset. The Pi may light only a slot returned by a verified `inventory.locate` result for a user request or approved guidance card; it clears the previous slot before lighting the next. If the manifest, layout or light map does not match the box, do not light a compartment. Printed slot labels and the screen diagram remain the location cues if a light fails. Photograph and check each slot-to-light mapping after assembly and whenever the tray or wiring changes.

## Running supply ledger (proposed; no weight or slot sensors)

Clara keeps a **running count** instead of sensing supplies. The rule: **the LLM turns what people say into structured entries; plain code keeps the count.** The LLM never edits a count directly.

1. **Starting stock.** At restock, a teammate records the quantity in each slot in the manifest (for example, "B2: 2 pressure dressings").
2. **Expected use during the session.** When the scenario reaches a step that uses an item, the box logs `supply.expected_use` (for example, the tourniquet step logs one tourniquet). This is deterministic, from the scenario file.
3. **Usage report (future).** After a user explicitly reports what was used, the agent may map the words ("both gauze rolls and some gloves") to manifest SKUs. Each `sku` must exist in the active manifest and each `qty` must be between 1 and the quantity on hand. Closing the lid does not start an agent turn because the microphone is off.
4. **Confirmation (unresolved).** A future voice confirmation or maintainer workflow must approve the proposed quantities before `supply.usage_confirmed` changes stock. The minimal screen has no supply counter or Confirm control. Until that path exists, the model does not offer `record_usage`; a report alone does not decrement stock.
5. **Ledger.** Stock per slot = starting quantity − confirmed use. Unverified slots are shown as "unverified" until the next restock check resets them. The agent and `inventory.locate` never claim an unverified item is present.
6. **Restock.** When a slot reaches its low threshold, the box's heartbeat reports `low_supplies` and the hub shows a restock alert. The hub keeps supply use per box over time for supply planning.

This replaces per-slot scanning during sessions; a teammate still verifies the tray at restock. A missing high-value item reported with no emergency session feeds the [anti-theft](anti-theft.md) flag.

Use [manifest and supply contracts](../contracts.md). Acceptance for future ledger work: scanning a wrong revision blocks map and light; a missing item is never described as present; expired supply is flagged; each screen/LED slot callout matches the physical tray in a photographed check; an agent-proposed usage with an unknown SKU or a quantity above stock is rejected; nothing changes the count without an explicit confirmation; an unconfirmed session leaves affected slots unverified. Assign one teammate to reset the demo tray between runs.
