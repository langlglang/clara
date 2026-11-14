import type { Metadata } from "next";
import Link from "next/link";
import { CompanionApp } from "../../components/companion/CompanionApp";

export const metadata: Metadata = { title: "Clara · Companion app" };

export default function AppPage() {
  return (
    <main id="main" className="phone">
      <div className="row between">
        <Link href="/" className="brand">
          Clara
        </Link>
      </div>
      <CompanionApp />
    </main>
  );
}
