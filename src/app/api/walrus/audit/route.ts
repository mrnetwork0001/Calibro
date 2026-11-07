import { errorResponse, getMemory, jsonResponse, resolveMode } from "@/lib/server/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Walks listNamespaces() + listMemories() (paginated by has_more) — the proof-of-Mainnet inventory. */
export async function GET(): Promise<Response> {
  try {
    const audit = await getMemory().auditInventory();
    const memories = audit.memories
      .filter((m) => m.namespace_id.startsWith("calibro:"))
      .map((m) => ({
        blobId: m.blob_id,
        namespace: m.namespace_id,
        createdAt: m.created_at,
        status: m.status,
        size: m.size,
      }));
    return jsonResponse(200, {
      mode: resolveMode(),
      totalMemories: audit.totalMemories,
      namespaces: audit.namespaces.map((n) => ({ name: n.name, memoryCount: n.memory_count, updatedAt: n.updated_at })),
      memories,
      accountId: process.env.MEMWAL_ACCOUNT_ID ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
