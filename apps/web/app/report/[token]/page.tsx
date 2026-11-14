import type { Metadata } from "next";
import { ReportView } from "../../../components/ReportView";

export const metadata: Metadata = { title: "Clara · EMS scene report (simulation)", robots: { index: false, follow: false } };

export default async function ReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <ReportView token={token} />;
}
