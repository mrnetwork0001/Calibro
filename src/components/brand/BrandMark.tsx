/**
 * Calibro's mark: a C inside a seal ring with the rust square, for forecasts sealed on
 * Walrus before the game. Plain vector shapes on a 64-unit grid, so it needs no font and
 * stays sharp at any size. `tone` is the background it sits on.
 */
const TONES = {
  dark: { fg: "#f5f3ee", faint: "rgba(245,243,238,0.28)", accent: "#e0663c" },
  light: { fg: "#151514", faint: "#cbc6b8", accent: "#b5401a" },
} as const;

export function BrandMark({ size = 28, tone = "dark", className, title }: { size?: number; tone?: keyof typeof TONES; className?: string; title?: string }) {
  const c = TONES[tone];
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <circle cx="32" cy="32" r="26" fill="none" stroke={c.fg} strokeWidth="3.5" />
      <circle cx="32" cy="32" r="20.5" fill="none" stroke={c.faint} strokeWidth="1.5" />
      <path d="M40.5 23 A12.5 12.5 0 1 0 40.5 41" fill="none" stroke={c.fg} strokeWidth="6" />
      <rect x="41" y="29" width="6" height="6" fill={c.accent} />
    </svg>
  );
}
