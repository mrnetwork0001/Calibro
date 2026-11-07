import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Lets a production build run (NEXT_DIST_DIR=.next-build) without disturbing a running dev server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // The landing page reads the Walrus ledger at build/revalidate time (≈ 16 SEAL-decrypted recalls).
  staticPageGenerationTimeout: 180,
  experimental: {
    // Dev-only fetch cache: it can't hold multi-MB Polymarket responses and its failure leaves
    // the fetch promise unsettled. Calibro keeps its own in-process caches instead.
    serverComponentsHmrCache: false,
  },
  serverExternalPackages: [
    "@mysten-incubation/memwal",
    "@mysten/seal",
    "@mysten/sui",
    "@mysten/walrus",
  ],
};

export default nextConfig;
