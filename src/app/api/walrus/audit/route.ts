import { cacheInfo, inventory } from "@/lib/server/read-models";
import { errorResponse, jsonResponse, resolveMode } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Walks listNamespaces() + listMemories() (paginated by has_more): the proof-of-Mainnet
 * inventory. Served through the shared read cache (refreshed every two minutes).
 */
export async function GET(): Promise<Response> {
  try {
    const inv = await inventory();
    return jsonResponse(200, { mode: resolveMode(), ...inv.value, cache: cacheInfo(inv) });
  } catch (err) {
    return errorResponse(err);
  }
}
