import { getMarketFeed, jsonResponse, errorResponse } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Real Polymarket markets: open pre-game markets + recently resolved ones (priced point-in-time). */
export async function GET(): Promise<Response> {
  try {
    return jsonResponse(200, await getMarketFeed());
  } catch (err) {
    return errorResponse(err);
  }
}
