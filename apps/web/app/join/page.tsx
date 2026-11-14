import type { Metadata } from "next";
import Link from "next/link";
import { CompanionApp } from "../../components/companion/CompanionApp";

export const metadata: Metadata = { title: "Clara · Join the network" };

/** The sign-up route: after joining it goes to the companion app. */
export default function JoinPage() {
  return (
    <main id="main" className="phone">
      <div className="row between">
        <Link href="/" className="brand">
          Clara
        </Link>
        <Link href="/app" className="lbl">
          Already joined? Open the app
        </Link>
      </div>
      <CompanionApp joinOnly />
    </main>
  );
}
