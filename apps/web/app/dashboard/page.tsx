import type { Metadata } from "next";
import { DispatchConsole } from "../../components/console/DispatchConsole";

export const metadata: Metadata = { title: "Clara · Dispatch and rides" };

export default function DashboardPage() {
  return <DispatchConsole />;
}
