import { getLedger, getMemory, getPayer, getTatum, jsonResponse, paymentConfig, resolveMode } from "@/lib/server/runtime";
import { hasOddsApiKey } from "@/lib/data/odds-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** Status ribbon: Tatum checkpoint + SUI/USD, Walrus relayer health, memory mode & count, payer. */
export async function GET(): Promise<Response> {
  const mode = resolveMode();
  const tatum = getTatum();
  const relayer = process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz";
  const { payer, error: payerError } = getPayer();

  const [checkpoint, suiRate, relayerHealth, namespaces, payerBalances] = await Promise.all([
    tatum.hasApiKey() ? settle(tatum.getLatestCheckpoint()) : Promise.resolve({ ok: false as const, error: "TATUM_API_KEY not set" }),
    settle(tatum.getUsdExchangeRate("SUI")),
    settle(
      fetch(`${relayer}/health`, { signal: AbortSignal.timeout(6_000) }).then(
        (r) => r.json() as Promise<{ status?: string; mode?: string; write_ready?: boolean }>
      )
    ),
    mode.mode !== "LIVE_MAINNET"
      ? Promise.resolve({ ok: false as const, error: `Not configured: ${mode.missing.join(", ")}` })
      : settle(getMemory().namespaceCounts()),
    payer && tatum.hasApiKey() ? settle(tatum.getAllBalances(payer.address)) : Promise.resolve(null),
  ]);

  const { treasury, coinType, amountRaw } = paymentConfig();
  const { ledger, error: ledgerError } = getLedger();
  return jsonResponse(200, {
    mode,
    data: { polymarket: true, espn: true, oddsApi: hasOddsApiKey() },
    replayLedger: { kind: ledger?.kind ?? null, error: ledgerError },
    tatum: { hasApiKey: tatum.hasApiKey(), graphqlUrl: tatum.graphqlUrl, checkpoint, suiRate },
    walrus: { relayer, health: relayerHealth, inventory: namespaces },
    payments: {
      treasury,
      coinType,
      amountRaw,
      payerAddress: payer?.address ?? null,
      payerError: payer ? undefined : payerError,
      payerBalances,
    },
    checkedAt: new Date().toISOString(),
  });
}
