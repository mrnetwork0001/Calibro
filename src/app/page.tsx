import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { CountUp } from "@/components/motion/CountUp";
import { Reveal } from "@/components/motion/Reveal";
import { HeroChart } from "@/components/landing/HeroChart";
import { LandingNav } from "@/components/landing/LandingNav";
import { LiveTicker } from "@/components/landing/LiveTicker";
import {
  getHeroSeries,
  getLedgerSummary,
  type LedgerSummary,
} from "@/lib/landing/ledger";
import { resolveMode } from "@/lib/server/runtime";
import { SPECIALIST_PROFILES } from "@/lib/specialists/models";
import type { MarketDomain, SpecialistId } from "@/lib/types/calibro";

/**
 * Rendered per request and streamed: the shell paints at once, live blocks fill in from
 * Calibro's own in-process caches (Walrus ledger, market feed). Not ISR: Next's fetch
 * cache can't hold the large Polymarket responses, and builds shouldn't depend on Walrus.
 */
export const dynamic = "force-dynamic";

const SOURCES: SpecialistId[] = [
  "sharp-steam",
  "power-rating",
  "onchain-flow",
  "hype-contrarian",
  "kalshi-crowd",
  "manifold-crowd",
  "top-pickers",
];
const LEAGUES: MarketDomain[] = ["NBA", "EPL", "UFC", "CRYPTO_MACRO"];
const LEAGUE: Record<MarketDomain, string> = {
  NBA: "NBA",
  EPL: "EPL",
  UFC: "UFC",
  CRYPTO_MACRO: "Crypto",
};
const CUTOFF = 0.265;
const short = (id: string) => `${id.slice(0, 8)}…${id.slice(-4)}`;

/* ------------------------------------------------------------------ layout */

function Container({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mx-auto w-full max-w-[1360px] px-5 sm:px-10 ${className}`}>
      {children}
    </div>
  );
}

/** A numbered section: label in the left column, content in the right. */
function Section({
  id,
  n,
  title,
  children,
  tone = "paper",
}: {
  id?: string;
  n: string;
  title: string;
  children: ReactNode;
  tone?: "paper" | "ruled" | "sunken";
}) {
  const bg =
    tone === "ruled" ? "ledger-light" : tone === "sunken" ? "bg-sunken" : "";
  return (
    <section id={id} className={`scroll-mt-16 border-t border-rule ${bg}`}>
      <Container className="grid gap-x-12 gap-y-6 py-14 sm:py-20 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-28">
        <Reveal>
          <p className="font-serif text-[44px] leading-none text-accent/80 italic sm:text-[56px]">
            {n}
          </p>
          <h2 className="mt-3 font-serif text-[28px] leading-[1.1] font-medium tracking-tight text-ink sm:text-[32px]">
            {title}
          </h2>
        </Reveal>
        <Reveal delay={120} className="min-w-0">
          {children}
        </Reveal>
      </Container>
    </section>
  );
}

function PrimaryLink({
  href,
  children,
  inverse,
}: {
  href: string;
  children: ReactNode;
  inverse?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`arrow-link inline-flex items-center gap-2.5 px-5 py-3 text-[15px] font-medium transition-colors ${
        inverse
          ? "bg-paper text-ink hover:bg-white"
          : "bg-ink text-paper hover:bg-ink-2"
      }`}
    >
      {children}
      <span className="arrow" aria-hidden>
        →
      </span>
    </Link>
  );
}

const Prose = ({ children }: { children: ReactNode }) => (
  <div className="max-w-[640px] space-y-4 text-[16px] leading-[1.7] text-ink-2">
    {children}
  </div>
);

/* --------------------------------------------------------- live exhibits */

/** Dot plot: each source's Brier in one league, with the refusal cutoff. */
function BrierExhibit({
  ledger,
  league,
}: {
  ledger: LedgerSummary;
  league: MarketDomain;
}) {
  const rows = ledger.calibrations
    .filter((c) => c.domain === league)
    .sort((a, b) => a.brierScore - b.brierScore);
  const lo = 0.1;
  const hi = 0.36;
  const W = 460;
  const left = 132;
  const right = 52;
  const rowH = 30;
  const top = 26;
  const H = top + rows.length * rowH + 30;
  const x = (v: number) =>
    left +
    ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (W - left - right);

  return (
    <figure className="border border-rule bg-surface">
      <figcaption className="border-b border-rule px-5 pt-4 pb-3">
        <p className="text-[12px] text-ink-3">Live from Walrus Memory</p>
        <p className="mt-0.5 font-serif text-[19px] leading-snug text-ink">
          Who Calibro pays in the {LEAGUE[league]}
        </p>
      </figcaption>
      <div className="px-3 pt-2 pb-3">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          role="img"
          aria-label={`Brier score by source, ${LEAGUE[league]}`}
        >
          {[0.15, 0.2, 0.25, 0.3, 0.35].map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                x2={x(t)}
                y1={top - 8}
                y2={H - 26}
                stroke="var(--color-rule)"
              />
              <text
                x={x(t)}
                y={H - 10}
                textAnchor="middle"
                className="fill-ink-3 text-[11px]"
              >
                {t.toFixed(2)}
              </text>
            </g>
          ))}
          <line
            x1={x(CUTOFF)}
            x2={x(CUTOFF)}
            y1={top - 14}
            y2={H - 26}
            stroke="var(--color-critical)"
            strokeDasharray="3 3"
          />
          <text
            x={x(CUTOFF) + 5}
            y={top - 6}
            className="fill-critical-ink text-[11px]"
          >
            refused above {CUTOFF}
          </text>
          {rows.map((r, i) => {
            const cy = top + i * rowH + rowH / 2;
            const refused = r.sampleSize >= 4 && r.brierScore > CUTOFF;
            return (
              <g key={r.specialistId}>
                <title>{`${SPECIALIST_PROFILES[r.specialistId].name}: Brier ${r.brierScore.toFixed(3)} over ${r.sampleSize} games${refused ? ", refused" : ""}`}</title>
                <text x={0} y={cy + 4} className="fill-ink-2 text-[13px]">
                  {SPECIALIST_PROFILES[r.specialistId].name}
                </text>
                <line
                  x1={x(lo)}
                  x2={x(r.brierScore)}
                  y1={cy}
                  y2={cy}
                  stroke="var(--color-rule-strong)"
                />
                <circle
                  cx={x(r.brierScore)}
                  cy={cy}
                  r={5.5}
                  fill={refused ? "var(--color-critical)" : "var(--color-ink)"}
                  stroke="#fff"
                  strokeWidth={2}
                />
                <text
                  x={W - right + 8}
                  y={cy + 4}
                  className="fill-ink-2 text-[12px]"
                  style={{ fontVariantNumeric: "tabular-nums" }}
                >
                  {r.brierScore.toFixed(3)}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="px-2 text-[12px] leading-relaxed text-ink-3">
          Brier score per source over real settled games; lower is better and
          0.250 is a coin flip. Sources marked red are no longer paid.
          {ledger.accountId && (
            <>
              {" "}
              Account{" "}
              <a
                className="link"
                href={`https://suiscan.xyz/mainnet/object/${ledger.accountId}`}
                target="_blank"
                rel="noreferrer"
              >
                {short(ledger.accountId)}
              </a>
              .
            </>
          )}
        </p>
      </div>
    </figure>
  );
}

async function HeroExhibit() {
  const data = await getHeroSeries();
  if (!data) {
    return (
      <div className="flex min-h-[340px] items-center justify-center border border-paper/15 px-8 text-center text-[14px] leading-relaxed text-paper/60">
        {resolveMode().mode === "LIVE_MAINNET"
          ? "Walrus Memory didn't answer in time. Refresh in a moment to see the live record."
          : "The Walrus Memory ledger isn't connected on this deployment, so no record is shown."}
      </div>
    );
  }
  return <HeroChart data={data} />;
}

function HeroChartSkeleton() {
  return (
    <div
      className="flex min-h-[380px] flex-col justify-between py-6"
      aria-label="Reading the record from Walrus Memory"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="h-px w-full bg-paper/10" />
      ))}
      <p className="text-[13px] text-paper/45">
        Reading the record from Walrus Memory…
      </p>
    </div>
  );
}

const STATIC_FIGURES: Array<[string, string]> = [
  ["7", "sources scored per league"],
  ["4", "Walrus Memory namespaces"],
  ["0.002", "SUI per signal, paid on Sui"],
  ["0", "language-model calls in the maths"],
];

function Figures({
  items,
  note,
}: {
  items: Array<[string, string]>;
  note?: string;
}) {
  return (
    <div className="border-y border-rule">
      <Container>
        <dl className="grid grid-cols-2 lg:grid-cols-4">
          {items.map(([v, l], i) => (
            <div
              key={l}
              className={`min-w-0 py-5 sm:py-6 ${i % 2 === 1 ? "pl-5 sm:pl-6" : ""} ${i > 0 ? "lg:border-l lg:border-rule lg:pl-8" : ""} ${i >= 2 ? "border-t border-rule lg:border-t-0" : ""}`}
            >
              <dt className="font-serif text-[34px] leading-none text-ink tabular-nums sm:text-[44px]">
                {/^\d+$/.test(v) ? <CountUp value={Number(v)} /> : v}
              </dt>
              <dd className="mt-2 text-[13px] text-ink-3">{l}</dd>
            </div>
          ))}
        </dl>
        {note && <p className="-mt-1 pb-4 text-[12px] text-ink-4">{note}</p>}
      </Container>
    </div>
  );
}

async function LiveFigures() {
  const l = await getLedgerSummary();
  if (!l || l.settledMarkets === 0) return <Figures items={STATIC_FIGURES} />;
  return (
    <Figures
      items={[
        [String(l.settledMarkets), "real games settled"],
        [String(l.totalMemories), "memories on Walrus Mainnet"],
        [String(l.paidWithDigest), "signals paid for on Sui"],
        [String(l.vetoes), "payments refused on the record"],
      ]}
      note="Read from the Walrus Memory account; refreshed every five minutes."
    />
  );
}

async function TrackRecord() {
  const ledger = await getLedgerSummary();
  if (!ledger || ledger.settledMarkets === 0) {
    return (
      <Prose>
        <p>
          {resolveMode().mode === "LIVE_MAINNET"
            ? "Walrus Memory didn't answer in time. Refresh in a moment to see the live record."
            : "The Walrus Memory ledger isn't connected on this deployment, so no record is shown. Nothing here is invented to fill the space."}
        </p>
      </Prose>
    );
  }
  const leagues = LEAGUES.filter((d) =>
    ledger.calibrations.some((c) => c.domain === d),
  );
  const cell = (id: SpecialistId, d: MarketDomain) =>
    ledger.calibrations.find((c) => c.specialistId === id && c.domain === d);
  const pnl = ledger.paperPnlUsd;

  return (
    <div className="space-y-12">
      <div className="grid items-start gap-10 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Prose>
          <p>
            Calibro trains on resolved Polymarket games, priced as they stood
            five minutes before the start, and settles each one to
            Polymarket&apos;s own result. Over {ledger.settledMarkets} games its
            forecasts scored a Brier of{" "}
            <span className="font-mono text-ink">
              {ledger.calibroBrier.toFixed(3)}
            </span>
            ; Polymarket&apos;s price scored{" "}
            <span className="font-mono text-ink">
              {ledger.marketBrier.toFixed(3)}
            </span>
            . It does not beat the market, and it doesn&apos;t claim to. What it
            does is learn which sources deserve to be paid: it refused{" "}
            {ledger.vetoes} payments to sources whose record fell below the
            cutoff. Its paper P&amp;L stands at {pnl >= 0 ? "+" : "−"}$
            {Math.abs(pnl).toFixed(0)} on a $2,500 bankroll.
          </p>
        </Prose>
        <BrierExhibit
          ledger={ledger}
          league={
            ledger.calibrations.some((c) => c.domain === "NBA")
              ? "NBA"
              : ledger.calibrations[0].domain
          }
        />
      </div>

      <figure>
        <figcaption className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <span className="font-serif text-[19px] text-ink">
            Brier score by source and league
          </span>
          <span className="text-[12px] text-ink-3">
            games scored in brackets · lower is better
          </span>
        </figcaption>
        <div className="overflow-x-auto border-y border-ink">
          <table className="w-full min-w-[560px] text-[14px]">
            <thead>
              <tr className="border-b border-rule text-left text-[12px] text-ink-3">
                <th className="py-2.5 pr-4 font-normal">Source</th>
                {leagues.map((d) => (
                  <th key={d} className="px-4 py-2.5 text-right font-normal">
                    {LEAGUE[d]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SOURCES.map((id) => (
                <tr key={id} className="border-b border-rule last:border-b-0">
                  <td className="py-2.5 pr-4 text-ink">
                    {SPECIALIST_PROFILES[id].name}
                  </td>
                  {leagues.map((d) => {
                    const c = cell(id, d);
                    const refused =
                      c && c.sampleSize >= 4 && c.brierScore > CUTOFF;
                    return (
                      <td
                        key={d}
                        className="px-4 py-2.5 text-right font-mono text-[13px] tabular-nums"
                      >
                        {!c ? (
                          <span className="text-ink-4">—</span>
                        ) : (
                          <span
                            className={
                              refused ? "text-critical-ink" : "text-ink"
                            }
                            title={`${c.sampleSize} games · ${c.x402PaidCount} paid · ${c.x402VetoedCount} refused`}
                          >
                            {c.brierScore.toFixed(3)}
                            <span className="ml-1 text-ink-4">
                              ({c.sampleSize})
                            </span>
                            {refused && (
                              <span className="ml-1.5 font-sans text-[12px]">
                                ✕ refused
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {ledger.latestSettledAt && (
          <p className="mt-2 text-[12px] text-ink-3">
            Last settlement{" "}
            {ledger.latestSettledAt.slice(0, 16).replace("T", " ")} UTC.
          </p>
        )}
      </figure>

      <div>
        <p className="font-serif text-[19px] text-ink">Check it yourself</p>
        <dl className="mt-3 grid gap-x-10 gap-y-3 text-[14px] sm:grid-cols-3">
          {(
            [
              ["Walrus Memory account", ledger.accountId, "object"],
              [
                "Agent wallet, pays for signals",
                ledger.agentAddress,
                "account",
              ],
              ["Treasury, receives signal fees", ledger.treasury, "account"],
            ] as const
          ).map(([label, id, kind]) =>
            id ? (
              <div key={label}>
                <dt className="text-[12px] text-ink-3">{label}</dt>
                <dd>
                  <a
                    className="link font-mono text-[13px]"
                    href={`https://suiscan.xyz/mainnet/${kind}/${id}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {short(id)}
                  </a>
                </dd>
              </div>
            ) : null,
          )}
        </dl>
        <p className="mt-3 text-[13px] text-ink-3">
          Every blob id and payment digest from training is listed in{" "}
          <span className="font-mono">docs/mainnet-memory-proof.json</span>.
        </p>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ page */

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <div className="ledger-dark grain grain-light relative overflow-hidden text-paper margin-gutter">
        <header className="sticky top-0 z-40 border-b border-paper/10 bg-ink/80 backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-[1440px] items-center justify-between gap-6 px-4 sm:px-10">
            <Link href="/" className="flex items-baseline gap-2">
              <span className="font-serif text-[22px] leading-none font-semibold tracking-tight text-paper">
                Calibro
              </span>
              <span
                className="inline-block h-1.5 w-1.5 translate-y-[-2px] bg-[#e0663c]"
                aria-hidden
              />
            </Link>
            <LandingNav />
          </div>
        </header>

        <LiveTicker />

        {/* Hero */}
        <Container className="relative z-10 grid items-center gap-10 pt-10 pb-14 sm:gap-14 sm:pt-16 sm:pb-20 lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] lg:pt-24 lg:pb-28">
          <div>
            <p
              className="rise text-[13px] tracking-wide text-paper/55"
              style={{ animationDelay: "60ms" }}
            >
              Sports &amp; prediction markets · Walrus Memory · Sui · Tatum
            </p>
            <h1
              className="rise mt-6 font-serif text-[44px] leading-[0.98] font-medium tracking-[-0.025em] text-paper min-[400px]:text-[52px] sm:text-[76px]"
              style={{ animationDelay: "140ms" }}
            >
              A forecaster
              <br />
              that keeps <em className="text-[#f08a62]">score</em>.
            </h1>
            <p
              className="rise mt-6 max-w-[520px] text-[16px] leading-[1.6] text-paper/75 sm:mt-7 sm:text-[18px]"
              style={{ animationDelay: "240ms" }}
            >
              Calibro pays for sports signals over HTTP 402, settles every
              forecast against the real result, and keeps each source&apos;s
              record on Walrus Memory. Next game, it pays the sources that were
              right, refuses the ones that weren&apos;t, and coaches the people
              who pick against it.
            </p>
            <div
              className="rise mt-8 flex flex-wrap items-center gap-x-7 gap-y-4 sm:mt-10"
              style={{ animationDelay: "340ms" }}
            >
              <PrimaryLink href="/app" inverse>
                Open the terminal
              </PrimaryLink>
              <Link
                href="/app/picks"
                className="arrow-link text-[15px] text-paper/80 underline decoration-paper/30 underline-offset-4 hover:text-paper hover:decoration-paper"
              >
                Make a pick <span className="arrow">→</span>
              </Link>
            </div>
          </div>
          <div className="rise" style={{ animationDelay: "200ms" }}>
            <Suspense fallback={<HeroChartSkeleton />}>
              <HeroExhibit />
            </Suspense>
          </div>
        </Container>
      </div>

      <Suspense fallback={<Figures items={STATIC_FIGURES} />}>
        <LiveFigures />
      </Suspense>

      <Section id="how" n="1" title="How it works">
        <div className="relative mb-10 hidden h-6 sm:block" aria-hidden>
          <div className="absolute top-1/2 right-0 left-0 h-px bg-rule-strong" />
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 border border-ink bg-paper"
              style={{ left: `calc(${(i / 3) * 100}% - 6px)` }}
            />
          ))}
          <div className="packet-x absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent shadow-[0_0_0_4px_rgba(181,64,26,0.15)]" />
        </div>
        <ol className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [
              "Recall",
              "For every market, Calibro reads three things from Walrus Memory: its risk mandate, each source's record in that league, and similar games it has settled before.",
            ],
            [
              "Decide who to pay",
              "A source is worth its fee only if its record says so. New sources get four games to prove themselves; after that, any source scoring worse than 0.265 is refused, and the reason is written down.",
            ],
            [
              "Pay and verify",
              "Signals sit behind HTTP 402. Calibro pays with a real Sui transfer, and the seller checks the transaction through Tatum's Sui gateway before releasing anything. Receipts are single use.",
            ],
            [
              "Learn",
              "When Polymarket resolves the game, Calibro scores every signal it bought, updates each source's calibration, and writes the post-mortem back to Walrus. Nobody types in a result.",
            ],
          ].map(([t, d], i) => (
            <li
              key={t}
              className="border-t border-rule pt-4 lg:border-t-0 lg:pt-0"
            >
              <p className="font-serif text-[14px] text-ink-3 italic">
                Step {i + 1}
              </p>
              <h3 className="mt-1 text-[17px] font-medium text-ink">{t}</h3>
              <p className="mt-2 text-[15px] leading-[1.65] text-ink-2">{d}</p>
            </li>
          ))}
        </ol>
        <figure className="mt-12 border border-rule bg-surface">
          <figcaption className="border-b border-rule px-5 py-3 text-[12px] text-ink-3">
            Exhibit 2 · one paid signal, as it travels
          </figcaption>
          <pre className="overflow-x-auto px-4 py-4 font-mono text-[11.5px] leading-[1.75] text-ink-2 sm:px-5 sm:text-[12.5px]">{`GET /api/signals/sharp-steam?marketId=poly-nba-…        402 Payment Required
    WWW-Authenticate: Payment protocol="mpp-sui-v1", network="sui:mainnet", amount="2000000", …
    X-Payment-Required: { x402Version: 1, accepts: [{ scheme: "exact", payTo: "0x5e2d…", … }] }

Sui transfer of 0.002 SUI to the seller's treasury

GET … X-Payment: { txDigest, challengeId, payer }        200 OK, signed signal
    checked through Tatum: succeeded, treasury credited, sender matches, never used before`}</pre>
        </figure>
      </Section>

      <Section id="record" n="2" title="The record so far" tone="ruled">
        <Suspense
          fallback={
            <p className="text-[15px] text-ink-3">
              Reading the track record from Walrus Memory…
            </p>
          }
        >
          <TrackRecord />
        </Suspense>
      </Section>

      <Section id="people" n="3" title="It remembers you, too">
        <div className="grid gap-x-12 gap-y-10 md:grid-cols-2">
          <div>
            <h3 className="font-serif text-[22px] text-ink">
              A pick journal with a memory
            </h3>
            <p className="mt-3 text-[15px] leading-[1.7] text-ink-2">
              Connect any Sui wallet and sign your probability before the game.
              The pick is sealed on Walrus with your signature, graded against
              Polymarket&apos;s result, and scored with the same maths Calibro
              applies to its own sources.
            </p>
          </div>
          <div>
            <h3 className="font-serif text-[22px] text-ink">
              A coach that has read your record
            </h3>
            <p className="mt-3 text-[15px] leading-[1.7] text-ink-2">
              Before you sign, Calibro looks up how your past picks at the same
              confidence actually turned out, and how you&apos;ve done when you
              disagreed with the market. When your record says your confidence
              runs high, it suggests the number your history supports, and your
              scorecard later shows whether listening helped.
            </p>
          </div>
          <div>
            <h3 className="font-serif text-[22px] text-ink">
              Paid for being right
            </h3>
            <p className="mt-3 text-[15px] leading-[1.7] text-ink-2">
              After three graded picks with a Brier of 0.25 or better, you
              become one of Calibro&apos;s sources. When it uses your picks, the
              fee is split by how much it trusts you and sent straight to your
              wallet on Sui. Stop being right, and it stops paying.
            </p>
          </div>
          <div className="flex items-end">
            <PrimaryLink href="/app/picks">Open the pick journal</PrimaryLink>
          </div>
        </div>
      </Section>

      <Section id="sources" n="4" title="The sources it weighs">
        <p className="max-w-[640px] text-[16px] leading-[1.7] text-ink-2">
          Seven sources, all paid through the same 402 gate. Four are
          Calibro&apos;s own documented models, two are outside crowds, and one
          is its best users. Each sees only data from before the game, and none
          is assumed to be good.
        </p>
        <div className="mt-8 overflow-x-auto border-y border-ink">
          <table className="w-full min-w-[640px] text-[14px]">
            <thead>
              <tr className="border-b border-rule text-left text-[12px] text-ink-3">
                <th className="py-2.5 pr-6 font-normal">Source</th>
                <th className="py-2.5 pr-6 font-normal">What it does</th>
                <th className="py-2.5 font-normal">Leagues</th>
              </tr>
            </thead>
            <tbody>
              {SOURCES.map((id) => {
                const p = SPECIALIST_PROFILES[id];
                return (
                  <tr
                    key={id}
                    className="border-b border-rule align-top last:border-b-0"
                  >
                    <td className="py-3 pr-6 whitespace-nowrap text-ink">
                      {p.name}
                    </td>
                    <td className="py-3 pr-6 leading-relaxed text-ink-2">
                      {p.thesis}.
                      <span className="block text-[13px] text-ink-3">
                        {p.dataSource}
                      </span>
                    </td>
                    <td className="py-3 text-[13px] whitespace-nowrap text-ink-3">
                      {p.coverage}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <Section id="agents" n="5" title="For other agents" tone="sunken">
        <Prose>
          <p>
            Calibro sells its own calibrated forecast over the same protocol,
            for 0.01 SUI. Any agent can buy it: the answer includes the
            probability, the sources Calibro paid and how it weighted them, the
            ones it refused and why, and the Walrus record of its reasoning. The
            revenue goes to the wallet that pays Calibro&apos;s sources.
          </p>
        </Prose>
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="border border-rule bg-surface px-5 py-4">
            <p className="text-[12px] text-ink-3">Discover</p>
            <p className="mt-1 font-mono text-[13px] text-ink">
              GET /.well-known/x402
            </p>
            <p className="mt-1 font-mono text-[13px] text-ink">GET /llms.txt</p>
          </div>
          <div className="border border-rule bg-surface px-5 py-4">
            <p className="text-[12px] text-ink-3">Buy</p>
            <p className="mt-1 font-mono text-[13px] text-ink">
              GET /api/forecast?marketId=…
            </p>
            <p className="mt-1 text-[13px] text-ink-3">
              402, then pay on Sui, then retry with X-Payment
            </p>
          </div>
        </div>
      </Section>

      <Section n="6" title="Method">
        <dl className="grid gap-x-10 gap-y-8 md:grid-cols-2">
          {[
            [
              "Brier score",
              "BS = (1/N) Σ (p − y)²",
              "The average squared miss. 0.25 is what a coin flip scores.",
            ],
            [
              "De-biasing",
              "logit p′ = α · logit p + β",
              "Fitted per source and league; an overconfident source drifts to α below 1.",
            ],
            [
              "Whether to pay",
              "VoI = bankroll · κ · (0.265 − BS) · γ",
              "A signal is bought only if its expected value beats the fee in USD.",
            ],
            [
              "Stake",
              "f = min(κ · (P·O − 1)/(O − 1), 5%)",
              "Quarter-Kelly at most, never more than 5% of the bankroll on one game.",
            ],
          ].map(([t, f, d]) => (
            <div key={t} className="border-t border-rule pt-4">
              <dt className="text-[15px] font-medium text-ink">{t}</dt>
              <dd className="mt-2 font-mono text-[14px] text-ink">{f}</dd>
              <dd className="mt-2 text-[14px] leading-relaxed text-ink-3">
                {d}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 max-w-[640px] text-[14px] leading-relaxed text-ink-3">
          All of it is deterministic TypeScript. No language model produces a
          probability, decides a payment or sets a stake.
        </p>
      </Section>

      <Section n="7" title="Notes">
        <ol className="max-w-[720px] list-decimal space-y-3 pl-5 text-[14px] leading-relaxed text-ink-2 marker:text-ink-4">
          <li>
            Markets, prices and results come from Polymarket; sportsbook lines
            and BPI from ESPN; Pinnacle from The Odds API; outside forecasts
            from Kalshi and Manifold. Nothing is simulated.
          </li>
          <li>
            Four sources are Calibro&apos;s own models sold to its own agent,
            and their fees go to a treasury we control. The payments are still
            real Sui transfers.
          </li>
          <li>
            Stakes are recommendations on a paper bankroll. Calibro does not
            place bets, and none of this is betting advice.
          </li>
          <li>
            Built for Total Recall, the Tatum × Walrus Memory hackathon.
            Apache-2.0.
          </li>
        </ol>
      </Section>

      <footer className="ledger-dark grain grain-light relative overflow-hidden text-paper margin-gutter">
        <Container className="relative z-10 py-14 sm:py-20">
          <Reveal>
            <p className="max-w-[720px] font-serif text-[34px] leading-[1.1] tracking-tight text-paper sm:text-[52px]">
              Every source earns its fee.{" "}
              <em className="text-[#f08a62]">Including you.</em>
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-x-7 gap-y-4">
              <PrimaryLink href="/app/picks" inverse>
                Make your first pick
              </PrimaryLink>
              <Link
                href="/app"
                className="arrow-link text-[15px] text-paper/80 underline decoration-paper/30 underline-offset-4 hover:text-paper"
              >
                Open the terminal <span className="arrow">→</span>
              </Link>
            </div>
          </Reveal>
          <div className="mt-14 flex flex-wrap items-center justify-between gap-4 border-t sm:mt-20 border-paper/10 pt-6 text-[13px] text-paper/50">
            <span className="font-serif text-[17px] text-paper">Calibro</span>
            <div className="flex gap-6">
              <Link href="/app" className="hover:text-paper">
                Terminal
              </Link>
              <Link href="/app/picks" className="hover:text-paper">
                Pick journal
              </Link>
              <a href="/llms.txt" className="hover:text-paper">
                llms.txt
              </a>
            </div>
          </div>
        </Container>
      </footer>
    </div>
  );
}
