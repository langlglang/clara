/** Original, non-instructional illustrations shipped with the Pi kiosk. IDs are the model's only visual choices. */
export const VISUALS = [
  {
    id: "kit_overview",
    title: "Clara kit layout",
    line: "Here is the three-compartment layout. Ask me for an item and I can light its compartment.",
    image_url: "/content/visuals/kit-overview-v1.svg",
    sku: null,
  },
  {
    id: "scissors_illustration",
    title: "Scissors illustration",
    line: "This is an illustration of the scissors. The item in this box may look different.",
    image_url: "/content/visuals/scissors-v1.svg",
    sku: "SCISSORS",
  },
  {
    id: "gloves_illustration",
    title: "Nitrile gloves illustration",
    line: "This is an illustration of nitrile exam gloves. The item in this box may look different.",
    image_url: "/content/visuals/gloves-v1.svg",
    sku: "GLOVES",
  },
  {
    id: "gauze_illustration",
    title: "Gauze pack illustration",
    line: "This is an illustration of a sterile gauze pack. The item in this box may look different.",
    image_url: "/content/visuals/gauze-v1.svg",
    sku: "GAUZE",
  },
  {
    id: "antiseptic_towelette_illustration",
    title: "Antiseptic towelette illustration",
    line: "This is an illustration of an antiseptic towelette. The packet in this box may look different.",
    image_url: "/content/visuals/antiseptic-towelette-v1.svg",
    sku: "ANTISEPTIC_TOWELETTES",
  },
  {
    id: "adhesive_bandage_illustration",
    title: "Adhesive bandage illustration",
    line: "This is an illustration of an adhesive bandage. The bandages in this box may look different.",
    image_url: "/content/visuals/adhesive-bandage-v1.svg",
    sku: "ADHESIVE_BANDAGES",
  },
  {
    id: "medical_tape_illustration",
    title: "Medical tape illustration",
    line: "This is an illustration of medical tape. The roll in this box may look different.",
    image_url: "/content/visuals/medical-tape-v1.svg",
    sku: "MEDICAL_TAPE",
  },
  {
    id: "cold_pack_illustration",
    title: "Instant cold pack illustration",
    line: "This is an illustration of an instant cold pack. The pack in this box may look different.",
    image_url: "/content/visuals/cold-pack-v1.svg",
    sku: "INSTANT_COLD_PACK",
  },
  {
    id: "minor_cut_rinse_cover",
    title: "Superficial cut or scrape care",
    line: "For a superficial cut or scrape, if running tap water or sterile saline is available, rinse until no visible debris remains. Once clean, cover with an adhesive bandage.",
    image_url: "/content/visuals/minor-cut-sequence-v1.svg",
    sku: "ADHESIVE_BANDAGES",
  },
] as const;

export type VisualId = (typeof VISUALS)[number]["id"];
export function visualById(id: string) {
  return VISUALS.find((visual) => visual.id === id) ?? null;
}

/** This source-linked care image is offered only for an explicitly described superficial injury. */
export function minorCutVisualAllowed(words: string): boolean {
  const text = words.toLowerCase();
  if (/\b(heavy|heavily|severe|deep|gaping|spurting|uncontrolled|bite|bitten|not sure|unsure|uncertain)\b/.test(text)) return false;
  return /\b(small|minor|superficial|shallow)\b/.test(text) && /\b(cut|scrape)\b/.test(text);
}

/** An unspecified finger cut needs a severity question before a bleeding protocol is shown. */
export function fingerCutNeedsClarification(words: string): boolean {
  const text = words.toLowerCase();
  const fingerCut = /\b(?:cut|scrape|gash)\b.{0,35}\b(?:finger|thumb)\b|\b(?:finger|thumb)\b.{0,35}\b(?:cut|scrape|gash)\b/.test(text);
  return fingerCut && !/\b(?:small|minor|superficial|shallow|deep|heavy|heavily|severe|spurting|gushing|uncontrolled|won't stop|cannot stop)\b/.test(text);
}
