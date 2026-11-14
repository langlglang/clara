# Clara illustration catalog v1

These nine SVGs are original project art. Eight are identification and orientation visuals, not first-aid instructions or photographs of the exact stocked packages. The ninth is linked only to the fictional minor-cut scenario described below. The source of truth for IDs, fixed spoken captions, and paths is [`packages/contracts/src/visuals.ts`](../../packages/contracts/src/visuals.ts). The Pi offers a visual ID to the agent only while that SVG exists locally. Equipment art is offered only while the matching SKU is stocked; the overview is offered only for layout `3slot-v1`.

| Asset | Subject | Dependency |
| --- | --- | --- |
| `kit-overview-v1.svg` | Top-left, top-right, and bottom compartments | `3slot-v1` physical layout |
| `scissors-v1.svg` | Generic scissors illustration | `SCISSORS` stocked |
| `gloves-v1.svg` | Generic nitrile exam gloves illustration | `GLOVES` stocked |
| `gauze-v1.svg` | Generic sealed gauze pack illustration | `GAUZE` stocked |
| `antiseptic-towelette-v1.svg` | Generic sealed towelette and wipe | `ANTISEPTIC_TOWELETTES` stocked |
| `adhesive-bandage-v1.svg` | Generic adhesive bandage | `ADHESIVE_BANDAGES` stocked |
| `medical-tape-v1.svg` | Generic medical tape roll | `MEDICAL_TAPE` stocked |
| `cold-pack-v1.svg` | Generic instant cold pack | `INSTANT_COLD_PACK` stocked |
| `minor-cut-sequence-v1.svg` | Two-panel rinse-and-cover sequence | `minor-cut-demo-v1` step `rinse_cover`; see [source review](../../docs/medical-safety.md#superficial-cut-visual-bundle--minor-cut-demo-v1-draft) |

The model can choose an offered `show_visual` ID but cannot submit a URL or author the caption. Any treatment diagram added later needs source-linked, versioned protocol text and a content review. The model must not infer an injury or a treatment from these illustrations.

The stocked supply is **antiseptic towelettes**, not a confirmed alcohol pad. The optional minor-cut scenario illustrates a source-supported rinse-with-water-or-saline, then adhesive-bandage sequence. This sequence asset is selected only through that scenario step, not through the general `show_visual` catalog; the scenario remains draft pending a teammate’s content check. It does not depict a towelette cleaning step.
