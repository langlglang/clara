# Kit inventory and compartment lights

**Implemented and physically verified on the current box, 2026-11-13:** three installed LEDs identify three compartments. The owner confirmed the supplies below are stocked in those positions, and observed each light with the integrated Pi-to-ESP32 command path after the lease-clock fix. This is a proof of concept, not a patient-ready medical kit.

| Physical compartment | ESP32 channel / pin | Stocked supplies |
| --- | --- | --- |
| Top-left, small (`top-left`) | 0 / GPIO18 | Scissors, medical tape, tweezers, adhesive bandages, antacid, first aid burn cream |
| Top-right, medium (`top-right`) | 1 / GPIO19 | Antiseptic towelettes, fingertip bandages, knuckle bandages, fabric bandages, ibuprofen, non-aspirin pain reliever, butterfly closures, nitrile exam gloves |
| Bottom, large (`bottom`) | 2 / GPIO23 | Instant cold pack, oval eye pad, sterile gauze packs, conforming gauze roll, trauma pad, cotton swabs, triple antibiotic ointment, popsicle sticks |

The source of truth is [`clara-3slot-v1.json`](../../content/kits/clara-3slot-v1.json): `kit_id: clara-3slot-v1`, `layout_revision: 3slot-v1`, one SKU per named supply, physical `slot`, and LED `channel`. The matching screen assets are `content/kits/layout-3slot-v1-{top-left,top-right,bottom}.svg`; each highlights the selected compartment. `on_hand: 1` means at least one item or pack was observed, **not** an exact piece count. Lot, expiry, package count and checker identity have not been recorded. The current `record_usage` action is unavailable, so these placeholders are not decremented during a conversation.

When someone asks where an item is, the cloud agent can choose only a SKU the Pi offered from this manifest. The English voice response names that item and says to look for its compartment light. The Pi checks the SKU again, shows the matching layout and slot name in a large visual, then sends one bounded LED command over USB. It marks the cue lit only after ACK and clears the cue when the firmware's 30-second lease ends. Guidance panels that name an item use the same lookup. Only one channel is lit at once; the previous light clears when another is selected, the lease expires, the lid closes, or the Pi disconnects. A failed LED command leaves the text and layout visible. The current bleeding scenario is still a draft. Its model-facing choices omit panels requiring absent equipment, such as a tourniquet or hemostatic gauze; it does not substitute another supply automatically.

## Restock and layout changes

1. Check every listed supply in its actual compartment. Record exact package count, lot and expiry before changing `on_hand` from the presence placeholder. Remove or set `on_hand: 0` for anything missing.
2. Open the lid and request one item from each compartment. Confirm the text, highlighted SVG, and physical LED agree: top-left → 0, top-right → 1, bottom → 2. Verify an item missing from the manifest is not offered or lit.
3. If the tray, wiring, or contents move, increment `kit_id` and `layout_revision` together. Update the JSON, each SVG, scenario item references, this table, tests, and the box's installed manifest in one change. Do not reuse the old revision for a new physical layout.
4. After any kit use or broken seal, a teammate checks and replenishes stock before claiming it is available again. Automatic per-item sensing, signed restock records, expiry enforcement, and a running ledger remain proposed.

The current tests check every listed SKU's slot/channel and exercise a Pi `locate_item` action for each of the three compartments. The hardware check is a separate observation: a serial ACK proves the ESP32 accepted a command; the owner's visual check proved the light actually appeared in the expected physical position.
