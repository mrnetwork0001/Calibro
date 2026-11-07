import { fromBase58, toBase58 } from "@mysten/sui/utils";

/**
 * A well-formed Sui transaction digest (base58 of 32 bytes) that carries a readable test
 * label, so stub verifiers can decide on it ("GOOD…" verifies, "BAD…" doesn't) while the
 * paywall's format check sees a real-shaped digest. Not a transaction on any chain.
 */
export const digest = (label: string): string => toBase58(new TextEncoder().encode(label.padEnd(32, ".").slice(0, 32)));

/** The label inside a digest made by `digest()`. */
export const digestLabel = (d: string): string => {
  try {
    return new TextDecoder().decode(fromBase58(d));
  } catch {
    return d;
  }
};
