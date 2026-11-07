import { describe, expect, it } from "vitest";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { buildPickMessage, parsePickMessage } from "../src/lib/picks/message";
import { applyGradedPick, emptyScorecard, gradePick, scorecardInsights } from "../src/lib/picks/scorecard";
import type { PickRecord } from "../src/lib/types/calibro";
import { CalibroMemoryClient, ownerRecallTag } from "../src/lib/walrus/memory-client";

const intent = {
  marketId: "poly-nba-123",
  question: "Celtics vs. Hornets",
  yesLabel: "Celtics",
  percent: 70,
  address: "0x" + "ab".repeat(32),
  signedAt: "2026-11-07T12:00:00.000Z",
};

function pick(over: Partial<PickRecord> = {}): PickRecord {
  return {
    kind: "pick_v1",
    owner: intent.address,
    marketId: "poly-nba-1",
    domain: "NBA",
    title: "A vs. B",
    yesLabel: "A",
    probability: 0.8,
    marketProbAtPick: 0.7,
    bookProbAtPick: 0.69,
    gameStart: "2026-11-08T00:00:00.000Z",
    pickedAt: "2026-11-07T12:00:00.000Z",
    message: "m",
    signature: "s",
    ...over,
  };
}

describe("Pick message", () => {
  it("round-trips exactly and rejects any edit", () => {
    const text = buildPickMessage(intent);
    expect(parsePickMessage(text)).toEqual(intent);
    expect(parsePickMessage(text.replace("70%", "71%  "))).toBeNull();
    expect(parsePickMessage(text.replace("70%", "100%"))).toBeNull();
    expect(parsePickMessage(text + "\nextra")).toBeNull();
  });

  it("verifies a real Sui wallet signature over the exact bytes, and fails for another address", async () => {
    const kp = new Ed25519Keypair();
    const text = buildPickMessage({ ...intent, address: kp.toSuiAddress() });
    const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(text));
    const pk = await verifyPersonalMessageSignature(new TextEncoder().encode(text), signature, { address: kp.toSuiAddress() });
    expect(pk.toSuiAddress()).toBe(kp.toSuiAddress());
    await expect(
      verifyPersonalMessageSignature(new TextEncoder().encode(text), signature, { address: new Ed25519Keypair().toSuiAddress() })
    ).rejects.toThrow();
    await expect(
      verifyPersonalMessageSignature(new TextEncoder().encode(text.replace("70%", "90%")), signature, { address: kp.toSuiAddress() })
    ).rejects.toThrow();
  });
});

describe("Scorecard (same maths as the specialists)", () => {
  it("grades, folds in once per market, and compares with the market on the same games", () => {
    const g = gradePick(pick(), 1, 0.74);
    expect(g.brier).toBeCloseTo(0.04, 10);
    expect(g.marketBrier).toBeCloseTo(0.09, 10);
    const c1 = applyGradedPick(emptyScorecard(intent.address), g);
    expect(c1).toMatchObject({ graded: 1, epoch: 1, calibroCompared: 1 });
    expect(c1.brier).toBeCloseTo(0.04, 6);
    expect(c1.marketBrier).toBeCloseTo(0.09, 6);
    expect(c1.calibroBrier).toBeCloseTo((0.74 - 1) ** 2, 6);
    expect(c1.byDomain.NBA?.sampleSize).toBe(1);
    expect(applyGradedPick(c1, g)).toBe(c1); // idempotent
  });

  it("diagnoses overconfidence on favourites with a shrunk estimate", () => {
    let card = emptyScorecard(intent.address);
    const outcomes: Array<0 | 1> = [1, 0, 0, 1, 0, 0];
    outcomes.forEach((y, i) => {
      card = applyGradedPick(card, gradePick(pick({ marketId: `poly-nba-${i}`, probability: 0.8 }), y, null));
    });
    expect(card.favourites.n).toBe(6);
    expect(card.favourites.statedAvg).toBeCloseTo(0.8, 6);
    expect(card.favourites.hitRate).toBeCloseTo(2 / 6, 6);
    expect(card.favourites.adjusted).toBeCloseTo((2 + 4 * 0.8) / 10, 6);
    const text = scorecardInsights(card).join(" ");
    expect(text).toMatch(/Overconfident on favourites: you average 80% but those sides won 33% of 6\. Calibro would shrink your 80% to 52%/);
  });

  it("stores and recalls picks and scorecards per owner on Walrus Memory (mock relayer)", async () => {
    const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX" });
    const other = "0x" + "cd".repeat(32);
    await memory.rememberPick(pick());
    await memory.rememberPick(pick({ owner: other, marketId: "poly-nba-9" }));
    const g = gradePick(pick(), 1, null);
    const card = applyGradedPick(emptyScorecard(intent.address), g);
    await memory.rememberScorecard(card);
    await memory.rememberPick(g);
    const mine = await memory.findUserPicks(intent.address);
    expect(mine).toHaveLength(1);
    expect(mine[0].record.outcome).toBe(1);
    expect((await memory.recallScorecard(intent.address))?.epoch).toBe(1);
    const toGrade = await memory.recallPicksToGrade();
    expect(toGrade.map((p) => p.owner)).toEqual([other]);
    expect(ownerRecallTag(intent.address)).toMatch(/^ow[0-9a-f]{16}$/);
  });
});

describe("Pick coach", async () => {
  const { coachPick } = await import("../src/lib/picks/coach");
  const history = (n: number, p: number, wins: number) =>
    Array.from({ length: n }, (_, i) => ({ domain: "NBA" as const, probability: p, marketProbAtPick: 0.7, outcome: (i < wins ? 1 : 0) as 0 | 1 }));
  const market = { domain: "NBA" as const, yesLabel: "Celtics", marketProb: 0.72 };

  it("reads an overconfident pick down from the user's own record, shrunk toward what they said", () => {
    const a = coachPick({ ...market, percent: 80, picks: history(9, 0.8, 5), league: null, marketHistory: [] });
    // (5 wins + 4 × 0.80) / (9 + 4) = 0.6308
    expect(a.suggestedPercent).toBe(63);
    expect(a.findings[0]).toMatchObject({ kind: "YOUR_CONFIDENCE", n: 9 });
    expect(a.findings[0].text).toMatch(/Your last 9 NBA picks at 73%–88% on a side won 5 \(56%\)\. Calibro reads your 80% on Celtics as 63%/);
  });

  it("works for picks against YES (backing the other side) and stays quiet when the record agrees", () => {
    const fadeHistory = history(6, 0.2, 1); // backed NO at 80%, NO won 5 of 6
    const a = coachPick({ ...market, percent: 20, picks: fadeHistory, league: null, marketHistory: [] });
    expect(a.suggestedPercent).toBe(null); // (5 + 3.2) / 10 = 0.82 ≈ stated 0.80 → no move
    const b = coachPick({ ...market, percent: 20, picks: history(6, 0.2, 4), league: null, marketHistory: [] });
    // Backed NO at 80% and NO won 2 of 6: (2 + 4 × 0.8) / 10 = 0.52 on NO → P(YES) 48%.
    expect(b.suggestedPercent).toBe(48);
  });

  it("starts with Calibro's own price record and asks for history before coaching on the user", () => {
    const settled = [
      { domain: "NBA" as const, p: 0.74, y: 1 as const },
      { domain: "NBA" as const, p: 0.7, y: 0 as const },
      { domain: "NBA" as const, p: 0.3, y: 0 as const },
      { domain: "NBA" as const, p: 0.76, y: 1 as const },
    ];
    const a = coachPick({ ...market, percent: 72, picks: [], league: null, marketHistory: settled });
    expect(a.suggestedPercent).toBeNull();
    expect(a.findings.map((f) => f.kind)).toEqual(["NEED_HISTORY", "PRICE_RECORD"]);
    expect(a.findings[1].text).toMatch(/In 4 NBA games Calibro has settled, the side Polymarket priced at 65%–80% won 3 \(75%\)/);
  });

  it("compares the user's disagreements with the market", () => {
    const picks = [
      { domain: "NBA" as const, probability: 0.8, marketProbAtPick: 0.6, outcome: 0 as const },
      { domain: "NBA" as const, probability: 0.3, marketProbAtPick: 0.5, outcome: 1 as const },
      { domain: "NBA" as const, probability: 0.65, marketProbAtPick: 0.55, outcome: 1 as const },
    ];
    const a = coachPick({ ...market, percent: 85, picks, league: null, marketHistory: [] });
    const f = a.findings.find((x) => x.kind === "YOU_VS_MARKET")!;
    expect(f.text).toMatch(/13 pts from Polymarket/);
    expect(f.text).toMatch(/the market was sharper/);
  });
});

describe("Scorecard tracks whether following the coach helped", () => {
  it("splits graded picks into followed vs ignored suggestions", () => {
    let card = emptyScorecard(intent.address);
    card = applyGradedPick(card, gradePick(pick({ marketId: "a", probability: 0.66, coach: { suggestedProbability: 0.66 } }), 1, null));
    card = applyGradedPick(card, gradePick(pick({ marketId: "b", probability: 0.8, coach: { suggestedProbability: 0.65 } }), 0, null));
    card = applyGradedPick(card, gradePick(pick({ marketId: "c", probability: 0.8, coach: { suggestedProbability: null } }), 1, null));
    expect(card.coach).toEqual({ followed: { n: 1, brierSum: 0.1156 }, ignored: { n: 1, brierSum: 0.64 } });
    expect(scorecardInsights(card).join(" ")).toMatch(/followed its suggestion \(1 picks\) you scored Brier 0\.116; when you didn't \(1\), 0\.640/);
  });
});
