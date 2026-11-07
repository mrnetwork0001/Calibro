import type { Metadata } from "next";
import { Terminal } from "@/components/terminal/Terminal";

export const metadata: Metadata = {
  title: "Calibro Terminal",
};

export default function AppPage() {
  return <Terminal />;
}
