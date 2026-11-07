"use client";

import type { AuditResponse } from "./api";
import { walruscanBlob } from "./api";
import { Badge, Empty, ErrorLine, ModeBadge } from "./ui";

export function WalrusDrawer(props: {
  open: boolean;
  onClose: () => void;
  audit: AuditResponse | null;
  error: string | null;
  loading: boolean;
}) {
  if (!props.open) return null;
  const a = props.audit;
  const live = a?.mode.mode === "LIVE_MAINNET";

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-ink/25" onClick={props.onClose}>
      <aside
        className="flex h-full w-full max-w-xl flex-col border-l border-rule-strong bg-surface"
        onClick={(e) => e.stopPropagation()}
        aria-label="Walrus memory inventory"
      >
        <header className="flex items-start justify-between gap-4 border-b border-rule px-4 py-4 sm:px-6">
          <div>
            <h2 className="font-serif text-[20px] font-medium text-ink">Memory inventory</h2>
            <p className="text-[12px] text-ink-3">Every record on the Walrus Memory account, walked live with listNamespaces() and listMemories()</p>
          </div>
          <button type="button" onClick={props.onClose} className="touch-btn shrink-0 text-[13px] text-ink-3 hover:text-ink">
            Close
          </button>
        </header>

        <div className="flex-1 overflow-auto px-4 py-5 sm:px-6">
          {props.loading && !a ? (
            <Empty>Walking listNamespaces() + listMemories()…</Empty>
          ) : (
            <>
              <ErrorLine error={props.error} />
              {a && (
                <>
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <ModeBadge mode={a.mode.mode} />
                    <Badge tone={live && a.totalMemories >= 10 ? "good" : "warning"}>{a.totalMemories} memories</Badge>
                    {a.accountId && <span className="font-mono text-[11px] break-all text-ink-3">account {a.accountId}</span>}
                  </div>
                  <div className="mb-5 grid grid-cols-2 border-y border-rule sm:grid-cols-4 sm:divide-x sm:divide-rule">
                    {["calibro:episodic", "calibro:calibration", "calibro:picks", "calibro:mandates"].map((ns) => {
                      const n = a.namespaces.find((x) => x.name === ns);
                      return (
                        <div key={ns} className="py-2.5 pr-3 max-sm:odd:pl-0 max-sm:even:pl-3 sm:px-3 sm:first:pl-0">
                          <p className="font-serif text-[24px] leading-tight text-ink tabular-nums">{n?.memoryCount ?? 0}</p>
                          <p className="truncate font-mono text-[11px] text-ink-3">{ns.replace("calibro:", "")}</p>
                        </div>
                      );
                    })}
                  </div>
                  {a.memories.length === 0 ? (
                    <Empty>No memories yet.</Empty>
                  ) : (
                    <table className="w-full text-[12px]">
                      <thead className="text-[12px] text-ink-3">
                        <tr>
                          <th className="py-1 text-left font-normal">Blob id</th>
                          <th className="py-1 text-left font-normal">Namespace</th>
                          <th className="py-1 text-right font-normal">Created</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.memories.map((m) => (
                          <tr key={`${m.blobId}-${m.namespace}`} className="border-t border-rule">
                            <td className="max-w-0 truncate py-1 pr-2 text-ink-2" title={m.blobId}>
                              {live ? (
                                <a href={walruscanBlob(m.blobId)} target="_blank" rel="noreferrer" className="link font-mono text-[11px]">
                                  {m.blobId}
                                </a>
                              ) : (
                                m.blobId
                              )}
                            </td>
                            <td className="py-1 pr-2 text-ink-3">{m.namespace.replace("calibro:", "")}</td>
                            <td className="py-1 text-right text-ink-3 tabular-nums">{new Date(m.createdAt).toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </>
              )}
            </>
          )}

          <div className="mt-8 border-t border-rule pt-4">
            <p className="font-serif text-[16px] text-ink">Portable memory</p>
            <p className="mt-1 text-[12px] leading-relaxed text-ink-3">
              A fresh process with no local database, given only the same Walrus account and delegate key, recalls this exact calibration state.
            </p>
            <pre className="mt-3 overflow-auto border border-rule bg-paper p-3 font-mono text-[11px] leading-relaxed text-ink-2">
              {`MEMWAL_ACCOUNT_ID=<same account> \\
MEMWAL_PRIVATE_KEY=<delegate key> \\
TATUM_API_KEY=<key> \\
npx tsx scripts/portable-agent-demo.ts`}
            </pre>
          </div>
        </div>
      </aside>
    </div>
  );
}
