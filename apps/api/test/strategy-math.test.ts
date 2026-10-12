import { describe, expect, it } from "vitest";
import { Money } from "../src/lib/money.js";
import { nextPrice, uniform, type GeneratorParams } from "../src/market/generator.js";
import { decide } from "../src/strategy/logic.js";
import {
  applyFill,
  costBasisReleased,
  drawdownRatio,
  execPrice,
  fillBuy,
  fillSell,
  lossBreach,
  positionLimitViolations,
  type Venue,
} from "../src/strategy/math.js";

const m = (v: string) => new Money(v);
const venue = (feeBps = "10", slippageBps = "0"): Venue => ({
  feeBps: m(feeBps),
  slippageBps: m(slippageBps),
  priceScale: 8,
  quantityScale: 8,
  quoteScale: 6,
});
const limits = { maxPositionValue: m("1000"), maxExposureRatio: m("0.5"), dailyLossLimit: m("100"), maxDrawdownRatio: m("0.2") };

describe("execution math (exact decimals)", () => {
  it("applies slippage against the trader and rounds against the trader", () => {
    expect(execPrice("buy", m("100"), venue("0", "10")).toFixed()).toBe("100.1");
    expect(execPrice("sell", m("100"), venue("0", "10")).toFixed()).toBe("99.9");
    expect(execPrice("buy", m("0.33333333"), venue("0", "1")).toFixed()).toBe("0.33336667"); // rounded up
    expect(execPrice("sell", m("0.33333333"), venue("0", "1")).toFixed()).toBe("0.33329999"); // rounded down
  });

  it("sizes a buy so notional + fee never exceeds the budget (independently computed values)", () => {
    const fill = fillBuy(m("1000"), m("100"), venue("10", "0"))!;
    expect(fill.quantity.toFixed()).toBe("9.99000999");
    expect(fill.notional.toFixed()).toBe("999.000999");
    expect(fill.fee.toFixed()).toBe("0.999001");
    expect(fill.notional.plus(fill.fee).toFixed()).toBe("1000");
    expect(fill.slippageCost.toFixed()).toBe("0");
  });

  it("computes sell proceeds, fees and slippage cost exactly", () => {
    const noSlip = fillSell(m("10"), m("110"), venue("10", "0"))!;
    expect([noSlip.notional.toFixed(), noSlip.fee.toFixed()]).toEqual(["1100", "1.1"]);
    const slip = fillSell(m("10"), m("110"), venue("10", "10"))!;
    expect(slip.execPrice.toFixed()).toBe("109.89");
    expect(slip.notional.toFixed()).toBe("1098.9");
    expect(slip.fee.toFixed()).toBe("1.0989");
    expect(slip.slippageCost.toFixed()).toBe("1.1");
  });

  it("returns no fill for budgets or quantities too small to trade", () => {
    expect(fillBuy(m("0"), m("100"), venue())).toBeNull();
    expect(fillBuy(m("0.000001"), m("100000"), venue())).toBeNull();
    expect(fillSell(m("0"), m("100"), venue())).toBeNull();
  });

  it("releases cost basis pro rata (rounded up) and exactly on a full close", () => {
    expect(costBasisReleased(m("1"), m("3"), m("100"), 6).toFixed()).toBe("33.333334");
    expect(costBasisReleased(m("3"), m("3"), m("100"), 6).toFixed()).toBe("100");
    expect(() => costBasisReleased(m("4"), m("3"), m("100"), 6)).toThrow();
  });

  it("books a profitable round trip exactly", () => {
    const v = venue("10", "0");
    const buy = fillBuy(m("5000"), m("102"), v)!;
    const afterBuy = applyFill({ cash: m("10000"), quantity: m("0"), costBasis: m("0") }, buy, 6).next;
    const sell = fillSell(afterBuy.quantity, m("105"), v)!;
    const result = applyFill(afterBuy, sell, 6);
    expect(result.realisedPnl.toFixed()).toBe("146.911911");
    expect(result.next.cash.toFixed()).toBe("10136.774989");
    expect(result.next.quantity.toFixed()).toBe("0");
    expect(result.next.costBasis.toFixed()).toBe("0");
  });

  it("books a losing round trip exactly", () => {
    const v = venue("10", "0");
    const buy = fillBuy(m("5000"), m("102"), v)!;
    const afterBuy = applyFill({ cash: m("10000"), quantity: m("0"), costBasis: m("0") }, buy, 6).next;
    const result = applyFill(afterBuy, fillSell(afterBuy.quantity, m("95"), v)!, 6);
    expect(result.realisedPnl.toFixed()).toBe("-342.794461");
    expect(result.next.cash.toFixed()).toBe("9647.558323");
  });
});

describe("risk math", () => {
  it("flags position, exposure and cash limit violations", () => {
    expect(positionLimitViolations({ cash: m("1000"), quantity: m("5"), costBasis: m("500") }, m("100"), limits, 6)).toEqual([]);
    expect(positionLimitViolations({ cash: m("100"), quantity: m("11"), costBasis: m("1100") }, m("100"), limits, 6)).toEqual([
      "max_position_value",
      "max_exposure_ratio",
    ]);
    expect(positionLimitViolations({ cash: m("-1"), quantity: m("0"), costBasis: m("0") }, m("100"), limits, 6)).toEqual([
      "insufficient_cash",
    ]);
  });

  it("measures drawdown and detects loss-limit breaches", () => {
    expect(drawdownRatio(m("1000"), m("800")).toFixed()).toBe("0.2");
    expect(drawdownRatio(m("1000"), m("1200")).toFixed()).toBe("0");
    expect(lossBreach(m("800"), m("1000"), m("800"), limits)?.limit).toBe("max_drawdown");
    expect(lossBreach(m("850"), m("1000"), m("950"), limits)?.limit).toBe("daily_loss");
    expect(lossBreach(m("900"), m("1000"), m("950"), limits)).toBeNull();
  });
});

describe("strategy decisions", () => {
  const base = { price: m("102"), equity: m("10000"), positionValue: m("0"), positionQty: m("0") };
  const trading = { lookbackTicks: 1, entryThresholdBps: 100, exitThresholdBps: -100, targetExposure: "0.5", minTradeValue: "1" };

  it("momentum enters, holds and exits deterministically", () => {
    expect(decide({ type: "trading", params: trading, lookbackPrice: m("100"), ...base })).toMatchObject({ action: "buy" });
    expect(decide({ type: "trading", params: trading, lookbackPrice: m("101.5"), ...base })).toEqual({ action: "hold" });
    expect(
      decide({ type: "trading", params: trading, lookbackPrice: m("110"), ...base, positionQty: m("1"), positionValue: m("102") }),
    ).toMatchObject({ action: "sell", all: true });
    expect(decide({ type: "trading", params: trading, lookbackPrice: null, ...base })).toMatchObject({ action: "hold" });
  });

  it("rebalancing respects the band", () => {
    const params = { targetExposure: "0.8", rebalanceBand: "0.05", minTradeValue: "10" };
    expect(decide({ type: "staking", params, lookbackPrice: null, ...base })).toMatchObject({ action: "buy" });
    expect(decide({ type: "staking", params, lookbackPrice: null, ...base, positionValue: m("7700") })).toEqual({ action: "hold" });
    expect(decide({ type: "lending", params, lookbackPrice: null, ...base, positionValue: m("9000"), positionQty: m("1") })).toMatchObject({
      action: "sell",
    });
  });
});

describe("synthetic generator", () => {
  const p: GeneratorParams = {
    seed: "test",
    startPrice: "100",
    driftBps: "1",
    volatilityBps: "50",
    shockProbability: "0.01",
    shockBps: "500",
    priceScale: 8,
  };

  it("is deterministic and bounded", () => {
    let a = m("100");
    let b = m("100");
    for (let seq = 1; seq <= 200; seq++) {
      a = nextPrice(a, p, seq);
      b = nextPrice(b, p, seq);
      expect(a.toFixed()).toBe(b.toFixed());
      expect(a.gt(0)).toBe(true);
      expect(a.decimalPlaces()).toBeLessThanOrEqual(8);
    }
    for (let i = 0; i < 100; i++) {
      const u = uniform("x", i, "noise");
      expect(u.gte(0) && u.lt(1)).toBe(true);
    }
  });
});
