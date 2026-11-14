import { ImageResponse } from "next/og";
import { ClaraMark } from "../lib/mark";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** Favicon. */
export default function Icon() {
  return new ImageResponse(<ClaraMark size={32} pad={0.12} />, size);
}
