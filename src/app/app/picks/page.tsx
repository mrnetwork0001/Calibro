import type { Metadata } from "next";
import { PicksApp } from "@/components/picks/PicksApp";

export const metadata: Metadata = { title: "Pick journal · Calibro" };

export default function PicksPage() {
  return <PicksApp />;
}
