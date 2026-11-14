import { ImageResponse } from "next/og";
import { ClaraMark } from "../lib/mark";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/** iPhone home-screen icon (iOS rounds the corners itself). */
export default function AppleIcon() {
  return new ImageResponse(<ClaraMark size={180} pad={0.2} />, size);
}
