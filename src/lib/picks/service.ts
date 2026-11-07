/**
 * Pick journal: accept wallet-signed picks before the game, seal them on Walrus, and
 * grade them against Polymarket's resolution with the same maths as the specialists.
 */
import { SuiGraphQLClient } from "@mysten/sui/graphql";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { getPolyMarket } from "../data/polymarket";
import { loadSnapshot } from "../markets/snapshot";
import { rateLimit } from "../server/rate-limit";
import { TATUM_SUI_GRAPHQL_URL, createTatumFetch, normalizeSuiAddress } from "../tatum/sui-rpc";
import type { PickRecord, ScorecardRecord } from "../types/calibro";
import type { CalibroMemoryClient } from "../walrus/memory-client";
import { parsePickMessage } from "./message";
import { applyGradedPick, emptyScorecard, gradePick } from "./scorecard";

export class PickError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

const SIGNED_MAX_AGE_MS = 10 * 60_000;
const PER_ADDRESS_PER_DAY = Number(process.env.CALIBRO_PICKS_PER_ADDRESS_PER_DAY ?? 12);
const GLOBAL_PER_DAY = Number(process.env.CALIBRO_PICKS_GLOBAL_PER_DAY ?? 400);

let verifyClient: SuiGraphQLClient | null = null;
function suiClient(): SuiGraphQLClient {
  const apiKey = process.env.TATUM_API_KEY ?? "";
  return (verifyClient ??= new SuiGraphQLClient({
    network: "mainnet",
    url: process.env.TATUM_SUI_MAINNET_GRAPHQL ?? TATUM_SUI_GRAPHQL_URL,
    headers: apiKey ? { "x-api-key": apiKey } : {},
    fetch: createTatumFetch(),
  }));
}

export async function submitPick(
  memory: CalibroMemoryClient,
  input: { message: string; signature: string; coach?: { suggestedPercent?: unknown } },
  now = new Date()
): Promise<{ pick: PickRecord; blobId: string }> {
  const intent = parsePickMessage(input.message ?? "");
  if (!intent || typeof input.signature !== "string") throw new PickError("Malformed pick message or signature.", 400);
  const owner = normalizeSuiAddress(intent.address);
  const age = now.getTime() - Date.parse(intent.signedAt);
  if (age > SIGNED_MAX_AGE_MS || age < -60_000) throw new PickError("Signature is stale; sign the pick again.", 400);

  try {
    await verifyPersonalMessageSignature(new TextEncoder().encode(input.message), input.signature, {
      address: owner,
      client: suiClient(),
    });
  } catch (err) {
    throw new PickError(`Signature does not verify for ${owner}: ${(err as Error).message}`, 401);
  }

  const snap = await loadSnapshot(intent.marketId);
  if (!snap) throw new PickError("Unknown or unpriceable market.", 404);
  const m = snap.market;
  if (m.source !== "LIVE") throw new PickError("This market has already started or resolved; picks close at the start.", 409);
  if (Date.parse(m.closesAt) <= now.getTime() + 60_000) throw new PickError("Picks close one minute before the start.", 409);
  if (m.title !== intent.question || m.yesLabel !== intent.yesLabel) throw new PickError("Signed market details don't match the market.", 400);

  const existing = await memory.findUserPicks(owner);
  if (existing.some((p) => p.record.marketId === m.marketId)) throw new PickError("You already have a pick on this market.", 409);

  const [mine, all] = await Promise.all([
    rateLimit(`picks:${owner}`, PER_ADDRESS_PER_DAY, 86_400),
    rateLimit("picks:all", GLOBAL_PER_DAY, 86_400),
  ]);
  if (!mine.ok) throw new PickError(`Daily limit of ${PER_ADDRESS_PER_DAY} picks reached for this wallet.`, 429);
  if (!all.ok) throw new PickError("Calibro's daily pick capacity is used up; try again tomorrow.", 429);

  const pick: PickRecord = {
    kind: "pick_v1",
    owner,
    marketId: m.marketId,
    domain: m.domain,
    title: m.title,
    yesLabel: m.yesLabel ?? "YES",
    probability: intent.percent / 100,
    marketProbAtPick: m.onchainImpliedProb,
    bookProbAtPick: m.bookImpliedProb,
    gameStart: m.closesAt,
    pickedAt: now.toISOString(),
    message: input.message,
    signature: input.signature,
    ...(input.coach
      ? {
          coach: {
            suggestedProbability:
              typeof input.coach.suggestedPercent === "number" && input.coach.suggestedPercent >= 1 && input.coach.suggestedPercent <= 99
                ? Math.round(input.coach.suggestedPercent) / 100
                : null,
          },
        }
      : {}),
  };
  const res = await memory.rememberPick(pick);
  return { pick, blobId: res.blob_id };
}

export interface GradeAttempt {
  owner: string;
  marketId: string;
  status: "GRADED" | "NOT_RESOLVED" | "VOID";
  brier?: number;
  scorecardEpoch?: number;
}

/**
 * Grades open picks whose market has resolved. Order matters for crash-safety: the
 * scorecard (which lists the markets it folded in) is written before the graded pick,
 * so a retry never double-counts.
 */
export async function gradeResolvedPicks(memory: CalibroMemoryClient, maxGraded = 6, now = new Date()): Promise<GradeAttempt[]> {
  const open = await memory.recallPicksToGrade();
  const attempts: GradeAttempt[] = [];
  const cards = new Map<string, ScorecardRecord>();
  let graded = 0;
  for (const pick of open) {
    if (graded >= maxGraded) break;
    const info = await getPolyMarket(pick.marketId);
    if (!info || info.resolution.status === "OPEN") {
      attempts.push({ owner: pick.owner, marketId: pick.marketId, status: "NOT_RESOLVED" });
      continue;
    }
    if (info.resolution.status === "VOID") {
      attempts.push({ owner: pick.owner, marketId: pick.marketId, status: "VOID" });
      continue;
    }
    const episodes = await memory.findMarketEpisodes(pick.marketId, `Domain=${pick.domain} Market="${pick.title}"`);
    const calibroProb = (episodes.settled ?? episodes.thesis)?.record.calibroCalibratedProb ?? null;
    const gradedPick = gradePick(pick, info.resolution.outcome, calibroProb, now);

    const card = cards.get(pick.owner) ?? (await memory.recallScorecard(pick.owner)) ?? emptyScorecard(pick.owner, now);
    const next = applyGradedPick(card, gradedPick, now);
    if (next !== card) await memory.rememberScorecard(next);
    cards.set(pick.owner, next);
    await memory.rememberPick(gradedPick);
    graded++;
    attempts.push({ owner: pick.owner, marketId: pick.marketId, status: "GRADED", brier: gradedPick.brier, scorecardEpoch: next.epoch });
  }
  return attempts;
}
