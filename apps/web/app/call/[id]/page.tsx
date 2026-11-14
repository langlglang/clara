import type { Metadata } from "next";
import { SimulatedCall } from "../../../components/SimulatedCall";

export const metadata: Metadata = { title: "Clara · Simulated 911 call", robots: { index: false, follow: false } };

/** /call/latest plays the newest emergency's call; /call/<incident id> a specific one. */
export default async function CallPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <SimulatedCall id={id} />;
}
