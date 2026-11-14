import { ImageResponse } from "next/og";
import { ClaraMark } from "../../../lib/mark";

/** Manifest icons, rendered once at build time: icon-192.png, icon-512.png and maskable-512.png. */
const ICONS: Record<string, { size: number; pad: number }> = {
  "icon-192.png": { size: 192, pad: 0.18 },
  "icon-512.png": { size: 512, pad: 0.18 },
  "maskable-512.png": { size: 512, pad: 0.28 },
};

export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(ICONS).map((file) => ({ file }));
}

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }): Promise<Response> {
  const { file } = await ctx.params;
  const icon = ICONS[file];
  if (!icon) return new Response("Not found", { status: 404 });
  return new ImageResponse(<ClaraMark size={icon.size} pad={icon.pad} />, { width: icon.size, height: icon.size });
}
