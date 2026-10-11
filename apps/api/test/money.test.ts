import { describe, expect, it } from "vitest";
import { format, Money, parseAmount, sum } from "../src/lib/money.js";

describe("money", () => {
  it("parses valid decimal strings exactly", () => {
    expect(parseAmount("100", 6).toFixed()).toBe("100");
    expect(parseAmount("0.000001", 6).toFixed()).toBe("0.000001");
    expect(parseAmount("12345678901234567890.123456", 6).toFixed()).toBe("12345678901234567890.123456");
  });

  it("rejects non-strings, negatives, zero, exponent notation and garbage", () => {
    for (const bad of [100, "-1", "0", "0.0", "1e3", "abc", "", " 1", "1.", ".5", "01", null, undefined, "NaN", "Infinity"]) {
      expect(() => parseAmount(bad, 6), String(bad)).toThrow();
    }
  });

  it("rejects more decimals than the asset scale", () => {
    expect(() => parseAmount("1.0000001", 6)).toThrow(/at most 6 decimal/);
    expect(() => parseAmount("1.5", 0)).toThrow();
  });

  it("does not suffer floating point error", () => {
    expect(new Money("0.1").plus("0.2").toFixed()).toBe("0.3");
    expect(sum(Array.from({ length: 10 }, () => "0.1")).toFixed()).toBe("1");
    expect(sum(["1000000.000001", "0.999999"]).toFixed()).toBe("1000001");
  });

  it("formats with fixed scale, truncating rather than rounding up", () => {
    expect(format("1.5", 6)).toBe("1.500000");
    expect(format("1.9999999", 6)).toBe("1.999999");
    expect(format("0", 6)).toBe("0.000000");
  });
});
