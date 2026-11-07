import { cacheInfo, recordView, settledGames } from "@/lib/server/read-models";
import { errorResponse, jsonResponse } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Every game Calibro has settled, read from its post-mortems on Walrus Memory: what it
 * forecast against Polymarket, which sources it paid (with the Sui digest of each x402
 * payment) and which it refused and why. Public and read-only.
 */
export async function GET(): Promise<Response> {
  try {
    const settled = await settledGames();
    return jsonResponse(200, { ...recordView(settled.value), cache: cacheInfo(settled) });
  } catch (err) {
    return errorResponse(err);
  }
}
