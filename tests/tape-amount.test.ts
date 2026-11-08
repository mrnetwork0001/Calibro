import { describe, expect, it } from "vitest";
import { formatAmount } from "../src/lib/x402/http-signal-provider";

describe("payment tape amounts", () => {
  it("shows SUI fees in SUI, not MIST", () => {
    expect(formatAmount("2000000", "0x2::sui::SUI")).toBe("0.002 SUI");
    expect(formatAmount("10000000", "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI")).toBe("0.01 SUI");
    expect(formatAmount("1000000000", "0x2::sui::SUI")).toBe("1 SUI");
  });
  it("names base units for other coins", () => {
    expect(formatAmount("5", "0xabc::usdc::USDC")).toBe("5 base units of USDC");
  });
});
