import type { Metadata } from "next";
import { NetworkConsole } from "../../components/console/NetworkConsole";

export const metadata: Metadata = { title: "Clara · Network and boxes" };

export default function MaintainerPage() {
  return <NetworkConsole />;
}
