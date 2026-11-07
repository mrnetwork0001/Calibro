import { describe, expect, it } from "vitest";
import {
  aggregateCalibratedSignals,
  computeFractionalKelly,
  createColdStartCalibration,
  shouldPayX402Gate,
  updateCalibrationOnline,
} from "../src/lib/calibration/brier";
import { CalibroMemoryClient } from "../src/lib/walrus/memory-client";
import {
  createX402Challenge,
  encodeX402PaymentProof,
  parseX402PaymentHeader,
} from "../src/lib/x402/protocol";
import type { BankrollMandateRecord } from "../src/lib/types/calibro";

const DEFAULT_MANDATE: BankrollMandateRecord = {
  kind: "mandate_v1",
  bankrollUsd: 2_500,
  kellyMultiplier: 0.25,
  maxSingleStakePct: 0.05,
  minEdgeThreshold: 0.02,
  maxSlateX402BudgetSui: 0.05,
  preferredDomains: ["NBA", "EPL", "CRYPTO_MACRO"],
  updatedAt: "2026-11-04T12:00:00.000Z",
};

describe("Calibro Closed-Loop Epistemic Memory & x402 Gate", () => {
  it("explores all specialists on Cold Start (Epoch 0), then vetoes noisy x402 source after recalling Walrus calibration memories", async () => {
    const memory = new CalibroMemoryClient({ mode: "MOCK_SANDBOX" });
    await memory.rememberMandate(DEFAULT_MANDATE);

    // 1. Cold start: zero memories in `calibro:calibration`
    const coldRecall = await memory.recallDomainCalibrations("NBA");
    expect(Object.keys(coldRecall.bySpecialist)).toHaveLength(0);

    let sharpCal = createColdStartCalibration("sharp-steam", "NBA");
    let hypeCal = createColdStartCalibration("hype-contrarian", "NBA");

    // Both specialists are approved during initial exploration
    expect(
      shouldPayX402Gate({
        calibration: sharpCal,
        mandate: DEFAULT_MANDATE,
        feeUsd: 0.0045,
      }).decision
    ).toBe("APPROVE_PAYMENT");
    expect(
      shouldPayX402Gate({
        calibration: hypeCal,
        mandate: DEFAULT_MANDATE,
        feeUsd: 0.0045,
      }).decision
    ).toBe("APPROVE_PAYMENT");

    // 2. Simulate 8 settled NBA games written into Walrus Memory:
    // - `sharp-steam` calls 72% on winners & 28% on losers (well-calibrated)
    // - `hype-contrarian` calls 86% on losers (overconfident noise)
    const outcomes: Array<0 | 1> = [1, 0, 1, 1, 0, 1, 0, 1];
    for (const outcome of outcomes) {
      sharpCal = updateCalibrationOnline(
        sharpCal,
        outcome === 1 ? 0.74 : 0.26,
        outcome
      );
      hypeCal = updateCalibrationOnline(
        hypeCal,
        outcome === 1 ? 0.22 : 0.86,
        outcome
      );
    }

    await memory.rememberCalibration(sharpCal);
    await memory.rememberCalibration(hypeCal);

    // 3. Stateless fresh recall from Walrus Memory (`sort: "recent"`)
    const recalled = await memory.recallDomainCalibrations("NBA");
    const recalledSharp = recalled.bySpecialist["sharp-steam"]!;
    const recalledHype = recalled.bySpecialist["hype-contrarian"]!;

    expect(recalledSharp.sampleSize).toBe(8);
    expect(recalledSharp.brierScore).toBeLessThan(0.12);
    expect(recalledHype.brierScore).toBeGreaterThan(0.35);
    expect(recalledHype.alphaSlope).toBeLessThan(1.0); // overconfidence shrunk!

    // 4. Deterministic x402 Gate now VETOES hype-contrarian & APPROVES sharp-steam
    const sharpGate = shouldPayX402Gate({
      calibration: recalledSharp,
      mandate: DEFAULT_MANDATE,
      feeUsd: 0.0045,
    });
    const hypeGate = shouldPayX402Gate({
      calibration: recalledHype,
      mandate: DEFAULT_MANDATE,
      feeUsd: 0.0045,
    });

    expect(sharpGate.decision).toBe("APPROVE_PAYMENT");
    expect(hypeGate.decision).toBe("VETO_PAYMENT");

    // 5. Consensus + Fractional Kelly sizing respects mandate caps
    const consensus = aggregateCalibratedSignals([
      {
        specialistId: "sharp-steam",
        rawProbability: 0.69,
        calibration: recalledSharp,
      },
    ]);
    const sizing = computeFractionalKelly({
      calibratedProb: consensus.calibratedConsensusProb,
      decimalOdds: 1.8, // 55.56% implied
      mandate: DEFAULT_MANDATE,
    });

    expect(sizing.action).toBe("TAKE_EDGE");
    expect(sizing.cappedKellyFraction).toBeLessThanOrEqual(0.05);
    expect(sizing.stakeUsd).toBeGreaterThan(0);

    // 6. Inventory walk confirms memories are stored across namespaces
    const audit = await memory.auditInventory();
    expect(audit.totalMemories).toBe(3);
  });

  it("round-trips dual HTTP 402 (x402 + MPP) challenge and payment proof headers", () => {
    const { challenge, headers } = createX402Challenge({
      specialistId: "sharp-steam",
      marketId: "nba-bos-nyk-20261106",
      recipient:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
    });

    expect(headers["WWW-Authenticate"]).toContain("Payment realm=");
    expect(headers["X-Payment-Required"]).toBeTruthy();

    const proofHeaders = encodeX402PaymentProof({
      challengeId: challenge.challengeId,
      txDigest: "8fK9mTestDigestSuiMainnet1111111111111111111",
      payer:
        "0x2222222222222222222222222222222222222222222222222222222222222222",
      network: "sui:mainnet",
      mode: "LIVE_MAINNET",
    });

    const reqHeaders = new Headers(proofHeaders);
    const parsed = parseX402PaymentHeader(reqHeaders);
    expect(parsed?.challengeId).toBe(challenge.challengeId);
    expect(parsed?.txDigest).toBe("8fK9mTestDigestSuiMainnet1111111111111111111");
  });
});
