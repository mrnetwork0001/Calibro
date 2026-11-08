import type { Metadata } from "next";
// Fonts are self-hosted from npm (Fontsource) rather than fetched from Google Fonts at build
// time: Google can return font URLs that next/font/google fails to parse on some build hosts.
import "@fontsource/newsreader/400.css";
import "@fontsource/newsreader/400-italic.css";
import "@fontsource/newsreader/500.css";
import "@fontsource/newsreader/500-italic.css";
import "@fontsource/newsreader/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./globals.css";

const DESCRIPTION =
  "Calibro scores every source it pays for against real results, keeps the record on Walrus Memory, pays for signals over x402 on Sui, and coaches the people who pick against it.";

// Absolute URLs for link previews: the production domain on Vercel, localhost in dev.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3004");

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Calibro — a forecaster that keeps score",
  description: DESCRIPTION,
  applicationName: "Calibro",
  openGraph: {
    type: "website",
    siteName: "Calibro",
    title: "Calibro — a forecaster that keeps score",
    description: DESCRIPTION,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: "Calibro — a forecaster that keeps score",
    description: DESCRIPTION,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
