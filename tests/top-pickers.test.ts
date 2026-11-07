import { describe, expect, it, vi } from "vitest";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { combineTopPickers, qualifies, type PickerEntry } from "../src/lib/picks/crowd";
import { applyGradedPick, emptyScorecard, gradePick } from "../src/lib/picks/scorecard";
import type { PickRecord, ScorecardRecord } from "../src/lib/types/calibro";
import { createX402Challenge, decodeX402Challenge, encodeX402PaymentProof, parseX402ChallengeHeaders } from "../src/lib/x402/protocol";
import { requirePayment } from "../src/lib/x402/paywall";
import { InMemoryReplayLedger } from "../src/lib/x402/replay-ledger";
import { handleSignalRequest } from "../src/lib/x402/signal-gate";
import { SuiX402Payer } from "../src/lib/x402/sui-payer";

const A = "0x" + "a1".repeat(32);
const B = "0x" + "b2".repeat(32);
const C = "0x" + "c3".repeat(32);
const AGENT = "0x" + "99".repeat(32);

function pick(owner: string, probability: number, marketId = "poly-nba-1"): PickRecord {
  return {
    kind: "pick_v1",
    owner,
    marketId,
    domain: "NBA",
    title: "A vs. B",
    yesLabel: "A",
    probability,
    marketProbAtPick: 0.6,
    bookProbAtPick: null,
    gameStart: "2026-11-08T00:00:00.000Z",
    pickedAt: "2026-11-07T12:00:00.000Z",
    message: "m",
    signature: "s",
  };
}

/** A scorecard built from real graded picks (same maths as production). */
function card(owner: string, results: Array<[number, 0 | 1]>): ScorecardRecord {
  let c = emptyScorecard(owner);
  results.forEach(([p, y], i) => (c = applyGradedPick(c, gradePick(pick(owner, p, `poly-nba-h${i}`), y, null))));
  return c;
}

const sharp = card(A, [[0.7, 1], [0.3, 0], [0.75, 1], [0.65, 1]]); // Brier ≈ 0.08
const decent = card(B, [[0.6, 1], [0.6, 0], [0.55, 1]]); // Brier ≈ 0.20
const noisy = card(C, [[0.9, 0], [0.9, 0], [0.2, 1]]); // Brier ≈ 0.75

describe("TopPickers: which humans count, and how the fee is split", () => {
  it("qualifies only pickers with ≥ 3 graded picks and Brier ≤ 0.25", () => {
    expect(qualifies(sharp)).toBe(true);
    expect(qualifies(decent)).toBe(true);
    expect(qualifies(noisy)).toBe(false);
    expect(qualifies(card(A, [[0.7, 1], [0.7, 1]]))).toBe(false); // too few
  });

  it("weights picks by trust, splits the fee exactly, and never pays the agent itself", () => {
    const entries: PickerEntry[] = [
      { pick: pick(A, 0.7), card: sharp },
      { pick: pick(B, 0.5), card: decent },
      { pick: pick(C, 0.1), card: noisy },
      { pick: pick(AGENT, 0.9), card: card(AGENT, [[0.7, 1], [0.3, 0], [0.8, 1]]) },
    ];
    const r = combineTopPickers(entries, 2_000_000n, [AGENT])!;
    expect(r.payees.map((p) => p.address)).toEqual([A, B]); // noisy and agent excluded, best first
    expect(r.payees.reduce((a, p) => a + BigInt(p.amountRaw), 0n)).toBe(2_000_000n);
    expect(BigInt(r.payees[0].amountRaw)).toBeGreaterThan(BigInt(r.payees[1].amountRaw));
    expect(r.probability).toBeGreaterThan(0.6); // pulled toward the sharper picker's 70%
    expect(r.probability).toBeLessThan(0.7);
    expect(combineTopPickers([{ pick: pick(C, 0.1), card: noisy }], 2_000_000n)).toBeNull();
  });
});

describe("Split x402 payments", () => {
  const splits = [
    { recipient: A, amountRaw: "1400000" },
    { recipient: B, amountRaw: "600000" },
  ];

  it("signs the shares into the challenge and exposes them in both protocol headers", () => {
    const { challenge, headers } = createX402Challenge({
      specialistId: "top-pickers",
      marketId: "poly-nba-1",
      recipient: A,
      amountRaw: "2000000",
      splits,
    });
    expect(decodeX402Challenge(challenge.challengeId)?.splits).toEqual(splits);
    expect(headers["WWW-Authenticate"]).toContain(`splits="${A}:1400000,${B}:600000"`);
    expect(parseX402ChallengeHeaders(new Headers(headers))?.splits).toEqual(splits);
    expect(() =>
      createX402Challenge({ specialistId: "top-pickers", marketId: "m", recipient: A, amountRaw: "2000000", splits: [{ recipient: A, amountRaw: "1" }] })
    ).toThrow(/sum/);
  });

  it("the paywall verifies every share was credited, via the signed challenge", async () => {
    const verify = vi.fn(async (p: { txDigest: string; expectedRecipient: string; minAmountRaw: bigint; additionalCredits?: Array<{ recipient: string; minAmountRaw: bigint }> }) => ({
      verified: p.txDigest === "GOOD",
      txDigest: p.txDigest,
      checkpoint: "1",
      recipientCreditedRaw: p.minAmountRaw,
      coinType: "0x2::sui::SUI",
      reason: "ok",
    }));
    const cfg = {
      product: "top-pickers" as const,
      marketId: "poly-nba-1",
      resource: "/api/signals/top-pickers?marketId=poly-nba-1",
      recipient: null,
      coinType: "0x2::sui::SUI",
      amountRaw: "2000000",
      ledger: new InMemoryReplayLedger(),
      verifier: { verifyX402PaymentOnSui: verify },
      splits,
    };
    const first = await requirePayment(new Request("http://x/"), cfg);
    const challenge = parseX402ChallengeHeaders((first as { response: Response }).response.headers)!;
    // Shares changed after the challenge (a new picker qualified): the signed shares still rule.
    const paid = await requirePayment(
      new Request("http://x/", { headers: encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: "GOOD", payer: AGENT, network: "sui:mainnet", mode: "LIVE_MAINNET" }) }),
      { ...cfg, splits: [{ recipient: C, amountRaw: "2000000" }] }
    );
    expect(paid).toMatchObject({ paid: true, receipt: { splits } });
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRecipient: A,
        minAmountRaw: 1_400_000n,
        additionalCredits: [{ recipient: B, minAmountRaw: 600_000n }],
      })
    );
  });

  it("the signal gate reports the paid people as payees and fires onPaid", async () => {
    const onPaid = vi.fn();
    const deps = {
      treasury: null,
      coinType: "0x2::sui::SUI",
      amountRaw: "2000000",
      ledger: new InMemoryReplayLedger(),
      verifier: {
        verifyX402PaymentOnSui: async (p: { txDigest: string; minAmountRaw: bigint }) => ({
          verified: true,
          txDigest: p.txDigest,
          recipientCreditedRaw: p.minAmountRaw,
          coinType: "0x2::sui::SUI",
          reason: "ok",
        }),
      },
      loadSignal: async () => ({
        status: "OK" as const,
        splits,
        signal: {
          specialistId: "top-pickers" as const,
          specialistName: "TopPickers",
          marketId: "poly-nba-1",
          domain: "NBA" as const,
          rawProbability: 0.64,
          confidenceTag: "MEDIUM" as const,
          rationale: "2 pickers",
          generatedAt: "2026-11-07T12:00:00.000Z",
        },
      }),
      onPaid,
    };
    const url = "http://x/api/signals/top-pickers?marketId=poly-nba-1";
    const first = await handleSignalRequest(new Request(url), "top-pickers", deps);
    expect(first.status).toBe(402);
    const challenge = parseX402ChallengeHeaders(first.headers)!;
    const res = await handleSignalRequest(
      new Request(url, { headers: encodeX402PaymentProof({ challengeId: challenge.challengeId, txDigest: "TX1", payer: AGENT, network: "sui:mainnet", mode: "LIVE_MAINNET" }) }),
      "top-pickers",
      deps
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { signal: { payees: unknown } };
    expect(body.signal.payees).toEqual([
      { address: A, amountRaw: "1400000" },
      { address: B, amountRaw: "600000" },
    ]);
    expect(onPaid).toHaveBeenCalledOnce();
  });

  it("the agent pays every share in one transaction and refuses to pay itself", async () => {
    const kp = new Ed25519Keypair();
    const payer = new SuiX402Payer({ privateKey: kp.getSecretKey(), tatumApiKey: "x" });
    const { challenge } = createX402Challenge({ specialistId: "top-pickers", marketId: "m", recipient: A, amountRaw: "2000000", splits });
    const data = payer.buildTransaction(challenge).getData();
    const kinds = data.commands.map((c) => c.$kind);
    expect(kinds).toEqual(["SplitCoins", "TransferObjects", "TransferObjects"]);
    expect(data.commands[0].SplitCoins!.amounts).toHaveLength(2);

    const self = createX402Challenge({
      specialistId: "top-pickers",
      marketId: "m",
      recipient: payer.address,
      amountRaw: "2000000",
      splits: [{ recipient: payer.address, amountRaw: "2000000" }],
    }).challenge;
    expect(() => payer.buildTransaction(self)).toThrow(/own wallet/);
  });
});
