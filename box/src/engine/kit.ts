import { readFileSync } from "node:fs";
import { z } from "zod";
import { Id, KitItemSchema, type KitItem } from "@clara/contracts";

/** A kit manifest file: a list of KitItem, or `{ "items": [...] }`. */
export const KitFileSchema = z.union([z.array(KitItemSchema), z.object({
  kit_id: Id.optional(), layout_revision: Id.optional(), note: z.string().optional(), items: z.array(KitItemSchema),
})]);

/**
 * The box's kit manifest: which item sits in which compartment, its LED channel, and how many are on hand.
 * Counts change only through `use` (a confirmed usage), never from a guess.
 */
export class Kit {
  private readonly items: Map<string, KitItem>;

  constructor(items: readonly KitItem[], readonly kitId: string | null = null, readonly layoutRevision: string | null = null) {
    this.items = new Map();
    // Several items can share a compartment (and so its LED); one LED must never point at two compartments.
    const slotOfLed = new Map<number, string>();
    for (const raw of items) {
      const item = KitItemSchema.parse(raw);
      if (this.items.has(item.sku)) throw new Error(`kit: duplicate sku "${item.sku}"`);
      const slot = slotOfLed.get(item.led);
      if (slot !== undefined && slot !== item.slot) throw new Error(`kit: LED channel ${item.led} is mapped to both ${slot} and ${item.slot}`);
      slotOfLed.set(item.led, item.slot);
      this.items.set(item.sku, { ...item });
    }
  }

  static empty(): Kit {
    return new Kit([]);
  }

  get(sku: string): KitItem | null {
    const item = this.items.get(sku);
    return item ? { ...item } : null;
  }

  all(): KitItem[] {
    return [...this.items.values()].map((item) => ({ ...item }));
  }

  /** What the voice turn state offers the model. */
  manifest(): { sku: string; name: string; on_hand: number }[] {
    return [...this.items.values()].map(({ sku, name, on_hand }) => ({ sku, name, on_hand }));
  }

  /** Takes `qty` off the count. False (and no change) for an unknown sku or more than is on hand. */
  use(sku: string, qty: number): boolean {
    const item = this.items.get(sku);
    if (!item || !Number.isInteger(qty) || qty < 1 || qty > item.on_hand) return false;
    item.on_hand -= qty;
    return true;
  }

  /** Items at or below their restock level. */
  low(): KitItem[] {
    return this.all().filter((item) => item.on_hand <= item.low_at);
  }
}

export function parseKit(json: unknown): Kit {
  const parsed = KitFileSchema.parse(json);
  return Array.isArray(parsed) ? new Kit(parsed) : new Kit(parsed.items, parsed.kit_id ?? null, parsed.layout_revision ?? null);
}

export function loadKit(path: string): Kit {
  return parseKit(JSON.parse(readFileSync(path, "utf8")));
}
