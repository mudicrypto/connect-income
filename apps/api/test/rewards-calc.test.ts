import { describe, expect, it } from "vitest";
import { Money } from "../src/lib/money.js";
import { calculateRewards, capitalIntegral, type CalcInput } from "../src/rewards/calc.js";

const m = (v: string | number) => new Money(v);
const alloc = (id: string, amount: string, overlapUs: string) => ({
  allocationId: id,
  investmentId: `inv-${id}`,
  userId: `user-${id}`,
  amount: m(amount),
  overlapUs: m(overlapUs),
});
const base = (o: Partial<CalcInput> = {}): CalcInput => ({
  trades: [],
  capitalIntegral: m("10000000"), // 10,000 USDT of paper capital for 1,000 µs
  allocations: [alloc("a", "3000", "1000"), alloc("b", "1000", "500")], // A = 3,500,000 -> 35% participation
  cfOpen: m(0),
  reserveOpen: m(0),
  reserveRatio: m("0.1"),
  scale: 6,
  ...o,
});
const s = (v: Money) => v.toFixed(6);

describe("reward calculation (values checked independently with Python decimal)", () => {
  it("distributes eligible realised profit pro rata after fees, losses and reserve", () => {
    const r = calculateRewards(
      base({
        trades: [
          { realisedPnl: m("1000"), fee: m("10") },
          { realisedPnl: m("-200"), fee: m("5") },
        ],
      }),
    );
    expect([s(r.grossGains), s(r.grossLosses), s(r.fees), s(r.netRealised)]).toEqual(["1000.000000", "200.000000", "15.000000", "785.000000"]);
    expect(r.customerFraction.toFixed()).toBe("0.35");
    expect(s(r.attributable)).toBe("274.750000");
    expect(s(r.eligibleProfit)).toBe("274.750000");
    expect(s(r.reserveContribution)).toBe("27.475000");
    expect(s(r.distributable)).toBe("247.275000");
    expect(r.lines.map((l) => s(l.reward))).toEqual(["211.950000", "35.325000"]);
    expect(s(r.roundingResidual)).toBe("0.000000");
    expect(r.totalRewards.plus(r.reserveContribution).eq(r.eligibleProfit)).toBe(true);
  });

  it("sends rounding residuals to the reserve so nothing is lost or created", () => {
    const r = calculateRewards(
      base({
        trades: [{ realisedPnl: m("1.111112"), fee: m(0) }],
        capitalIntegral: m("3"),
        allocations: [alloc("a", "1", "1"), alloc("b", "1", "1"), alloc("c", "1", "1")],
        reserveRatio: m(0),
      }),
    );
    expect(r.lines.map((l) => s(l.reward))).toEqual(["0.370370", "0.370370", "0.370370"]);
    expect(s(r.roundingResidual)).toBe("0.000002");
    expect(s(r.reserveContribution)).toBe("0.000002");
    expect(r.totalRewards.plus(r.reserveContribution).eq(r.eligibleProfit)).toBe(true);
  });

  it("pays nothing in a loss period: the reserve absorbs first, then the loss carries forward", () => {
    const r = calculateRewards(base({ trades: [{ realisedPnl: m("-500"), fee: m(0) }], reserveOpen: m("100") }));
    expect(s(r.attributable)).toBe("-175.000000");
    expect(s(r.reserveApplied)).toBe("100.000000");
    expect(s(r.cfClose)).toBe("75.000000");
    expect(s(r.eligibleProfit)).toBe("0.000000");
    expect(s(r.totalRewards)).toBe("0.000000");
    expect(r.lines.every((l) => l.reward.isZero())).toBe(true);
  });

  it("pays nothing in a zero-profit period, and time alone never creates rewards", () => {
    const r = calculateRewards(base());
    expect(s(r.netRealised)).toBe("0.000000");
    expect(s(r.totalRewards)).toBe("0.000000");
    expect(s(r.cfClose)).toBe("0.000000");
    expect(r.lines).toHaveLength(2); // participation recorded, reward zero
  });

  it("fees alone produce a loss, never a reward", () => {
    const r = calculateRewards(base({ trades: [{ realisedPnl: m(0), fee: m("3") }] }));
    expect(r.attributable.lt(0)).toBe(true);
    expect(r.totalRewards.isZero()).toBe(true);
  });

  it("gives nothing to customers when no allocation overlaps the period", () => {
    const r = calculateRewards(base({ trades: [{ realisedPnl: m("1000"), fee: m(0) }], allocations: [alloc("a", "1000", "0")] }));
    expect(r.customerFraction.isZero()).toBe(true);
    expect(r.lines).toHaveLength(0);
    expect(r.totalRewards.isZero()).toBe(true);
  });

  it("loss carry-forward stops a recovery of lost capital from being paid out", () => {
    // Period 1: customer-attributable loss of 100; period 2: +60 (recovery only); period 3: +100 (40 recovery, 60 eligible).
    const fraction = { capitalIntegral: m("1"), allocations: [alloc("a", "1", "1")], reserveRatio: m(0) };
    const p1 = calculateRewards(base({ ...fraction, trades: [{ realisedPnl: m("-100"), fee: m(0) }] }));
    expect(s(p1.cfClose)).toBe("100.000000");
    const p2 = calculateRewards(base({ ...fraction, trades: [{ realisedPnl: m("60"), fee: m(0) }], cfOpen: p1.cfClose }));
    expect([s(p2.cfRecovered), s(p2.eligibleProfit), s(p2.cfClose)]).toEqual(["60.000000", "0.000000", "40.000000"]);
    const p3 = calculateRewards(base({ ...fraction, trades: [{ realisedPnl: m("100"), fee: m(0) }], cfOpen: p2.cfClose }));
    expect([s(p3.cfRecovered), s(p3.eligibleProfit), s(p3.cfClose)]).toEqual(["40.000000", "60.000000", "0.000000"]);
    // Net over the three periods: -100 + 60 + 100 = 60, exactly what was paid.
    expect(s(p1.totalRewards.plus(p2.totalRewards).plus(p3.totalRewards))).toBe("60.000000");
  });

  it("never pays from unrealised gains (only trades are inputs) and caps the customer share at 100%", () => {
    const r = calculateRewards(
      base({ trades: [{ realisedPnl: m("100"), fee: m(0) }], capitalIntegral: m("1"), allocations: [alloc("a", "5", "1")], reserveRatio: m(0) }),
    );
    expect(r.customerFraction.toFixed()).toBe("1");
    expect(s(r.totalRewards)).toBe("100.000000");
  });

  it("holds its accounting identities over a long random sequence", () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    let cf = m(0);
    let reserve = m(0);
    let sumE = m(0);
    let sumN = m(0);
    let sumApplied = m(0);
    for (let i = 0; i < 300; i++) {
      const trades = Array.from({ length: Math.floor(rand() * 4) }, () => ({
        realisedPnl: m(Math.floor((rand() - 0.45) * 1e8)).div(1e6),
        fee: m(Math.floor(rand() * 1e6)).div(1e6),
      }));
      const allocations = Array.from({ length: 1 + Math.floor(rand() * 5) }, (_, k) =>
        alloc(`x${k}`, m(Math.floor(rand() * 1e9)).div(1e6).toFixed(6), String(Math.floor(rand() * 1000))),
      );
      const r = calculateRewards({ trades, capitalIntegral: m("1000000000000"), allocations, cfOpen: cf, reserveOpen: reserve, reserveRatio: m("0.15"), scale: 6 });
      expect(r.totalRewards.lte(r.distributable)).toBe(true); // the cap
      expect(r.totalRewards.plus(r.reserveContribution).eq(r.eligibleProfit)).toBe(true); // conservation
      expect(r.roundingResidual.gte(0)).toBe(true);
      expect(r.cfClose.gte(0) && r.eligibleProfit.gte(0)).toBe(true);
      expect(r.eligibleProfit.lte(Money.max(r.attributable, 0))).toBe(true);
      for (const l of r.lines) expect(l.reward.gte(0) && l.reward.decimalPlaces() <= 6).toBe(true);
      sumE = sumE.plus(r.eligibleProfit);
      sumN = sumN.plus(r.attributable);
      sumApplied = sumApplied.plus(r.reserveApplied);
      cf = r.cfClose;
      reserve = reserve.plus(r.reserveContribution).minus(r.reserveApplied);
    }
    // Everything ever made eligible = cumulative attributable result + unrecovered losses + reserve used.
    expect(sumE.eq(sumN.plus(cf).plus(sumApplied))).toBe(true);
  });
});

describe("capital integral", () => {
  it("integrates a step function of paper capital over a period", () => {
    const changes = [
      { atUs: m(0), delta: m(100) },
      { atUs: m(50), delta: m(100) },
      { atUs: m(500), delta: m(1000) },
    ];
    expect(capitalIntegral(changes, m(0), m(100)).toFixed()).toBe(String(100 * 50 + 200 * 50));
    expect(capitalIntegral(changes, m(60), m(100)).toFixed()).toBe(String(200 * 40));
    expect(capitalIntegral(changes, m(400), m(600)).toFixed()).toBe(String(200 * 100 + 1200 * 100));
    expect(capitalIntegral([], m(0), m(100)).toFixed()).toBe("0");
  });
});
