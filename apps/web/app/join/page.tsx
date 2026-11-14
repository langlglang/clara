import type { Metadata } from "next";
import { Onboarding } from "../../components/companion/Onboarding";

export const metadata: Metadata = { title: "Clara · Join the network" };

/** Joining Clara: the step-by-step onboarding (phone first). When it's done it opens the companion app at /app. */
export default function JoinPage() {
  return (
    <main id="main" className="phone">
      <Onboarding />
    </main>
  );
}
