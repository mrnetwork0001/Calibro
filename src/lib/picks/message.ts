/**
 * The exact text a user signs with their Sui wallet to log a pick. Shared by the browser
 * (builds it) and the server (parses + verifies it), so both agree byte for byte.
 */
export interface PickIntent {
  marketId: string;
  question: string;
  yesLabel: string;
  /** Whole percent, 1–99 */
  percent: number;
  address: string;
  signedAt: string;
}

const HEADER = "Calibro pick v1";

export function buildPickMessage(p: PickIntent): string {
  return [
    HEADER,
    `Market: ${p.marketId}`,
    `Question: ${p.question}`,
    `YES: ${p.yesLabel}`,
    `My probability of YES: ${p.percent}%`,
    `Address: ${p.address}`,
    `Signed at: ${p.signedAt}`,
    "",
    "Signing records this pick on Walrus Memory. It costs nothing and moves no funds.",
  ].join("\n");
}

export function parsePickMessage(text: string): PickIntent | null {
  const lines = text.split("\n");
  if (lines[0] !== HEADER) return null;
  const get = (label: string) => lines.find((l) => l.startsWith(`${label}: `))?.slice(label.length + 2);
  const marketId = get("Market");
  const question = get("Question");
  const yesLabel = get("YES");
  const pct = /^(\d{1,2})%$/.exec(get("My probability of YES") ?? "");
  const address = get("Address");
  const signedAt = get("Signed at");
  if (!marketId || !question || !yesLabel || !pct || !address || !signedAt) return null;
  const percent = Number(pct[1]);
  if (percent < 1 || percent > 99 || !Number.isFinite(Date.parse(signedAt))) return null;
  if (buildPickMessage({ marketId, question, yesLabel, percent, address, signedAt }) !== text) return null;
  return { marketId, question, yesLabel, percent, address, signedAt };
}
