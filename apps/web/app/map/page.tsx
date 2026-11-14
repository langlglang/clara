import type { Metadata } from "next";
import { KitMapView } from "../../components/KitMapView";
import { TopBar } from "../../components/TopBar";

export const metadata: Metadata = { title: "Clara · Kit map" };

export default function MapPage() {
  return (
    <>
      <TopBar current="/map" title="Clara Kits" />
      <main id="main" className="page">
        <KitMapView />
      </main>
    </>
  );
}
