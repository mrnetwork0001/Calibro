import type { Metadata } from "next";
import { RecordApp } from "@/components/record/RecordApp";

export const metadata: Metadata = { title: "Record · Calibro" };

export default function RecordPage() {
  return <RecordApp />;
}
