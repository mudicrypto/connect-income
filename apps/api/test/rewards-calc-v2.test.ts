import { describe, expect, it } from "vitest";
import { Money } from "../src/lib/money.js";
import { calculateRewardsV2, type CalcAllocationV2, type CalcResultV2 } from "../src/rewards/calc.js";

const m = (v: string | number) => new Money(v);
const s = (v: Money) => v.toFixed(6);

/** Carries per-allocation balances between periods, as posted lines do in the database. */
class Book {
  state = new Map<string, { lossOpen: Money; reserveOpen: Money }>();
  period(R: string, allocs: Record<string, { amount: string; overlap?: string }>, opts: { capital?: string; rho?: string } = {}): CalcResultV2 {
    const allocations: CalcAllocationV2[] = Object.entries(allocs).map(([id, a]) => ({
      allocationId: id,
      investmentId: `inv-${id}`,
      userId: `user-${id}`,
      amount: m(a.amount),
      overlapUs: m(a.overlap ?? "1"),
      ...(this.state.get(id) ?? { lossOpen: m(0), reserveOpen: m(0) }),
    }));
    const r = calculateRewardsV2({
      trades: R === "0" ? [] : [{ realisedPnl: m(R), fee: m(0) }],
      capitalIntegral: m(opts.capital ?? "10000"),
      allocations,
      reserveRatio: m(opts.rho ?? "0.1"),
      scale: 6,
    });
    for (const l of r.lines) this.state.set(l.allocationId, { lossOpen: l.lossClose, reserveOpen: l.reserveClose });
    return r;
  }
  line(r: CalcResultV2, id: string) {
    const l = r.lines.find((x) => x.allocationId === id)!;
    return {
      n: s(l.attributable),
      rec: s(l.lossRecovered),
      e: s(l.eligible),
      q: s(l.reserveContribution),
      reward: s(l.reward),
      L: s(l.lossClose),
      V: s(l.reserveClose),
      r: s(l.reserveApplied),
    };
  }
}

describe("per-investment loss recovery (docs/rewards-accounting-v2.md worked example, verified in Python)", () => {
  it("a later investor does not inherit an earlier loss; the earlier investor recovers their own", () => {
    const b = new Book();
    const p1 = b.period("-200", { alice: { amount: "5000" } });
    expect(b.line(p1, "alice")).toMatchObject({ n: "-100.000000", L: "100.000000", reward: "0.000000" });

    const p2 = b.period("300", { alice: { amount: "5000" }, bob: { amount: "5000" } });
    expect(b.line(p2, "alice")).toEqual({ n: "150.000000", rec: "100.000000", e: "50.000000", q: "5.000000", reward: "45.000000", L: "0.000000", V: "5.000000", r: "0.000000" });
    expect(b.line(p2, "bob")).toEqual({ n: "150.000000", rec: "0.000000", e: "150.000000", q: "15.000000", reward: "135.000000", L: "0.000000", V: "15.000000", r: "0.000000" });
    expect(s(p2.totalRewards)).toBe("180.000000"); // same total as v1, fairly split (v1 paid 90 / 90)
    expect(s(p2.cfRecovered)).toBe("100.000000");

    const p3 = b.period("-100", { alice: { amount: "5000" }, bob: { amount: "5000" } });
    expect(b.line(p3, "alice")).toMatchObject({ n: "-50.000000", r: "5.000000", L: "45.000000", V: "0.000000" });
    expect(b.line(p3, "bob")).toMatchObject({ n: "-50.000000", r: "15.000000", L: "35.000000", V: "0.000000" });
    expect(s(p3.reserveApplied)).toBe("20.000000");
    expect(s(p3.totalRewards)).toBe("0.000000");
  });

  it("partial participation scales the attribution by overlap; zero overlap means no line", () => {
    const b = new Book();
    const r = b.period("1000", { full: { amount: "4000", overlap: "100" }, half: { amount: "4000", overlap: "50" }, none: { amount: "4000", overlap: "0" } }, { capital: "1000000" });
    expect(r.lines.map((l) => l.allocationId)).toEqual(["full", "half"]);
    expect(b.line(r, "full").n).toBe("400.000000"); // 1000 x 400,000 / 1,000,000
    expect(b.line(r, "half").n).toBe("200.000000");
  });

  it("rounds attribution toward minus infinity and keeps the remainder with the pool", () => {
    const b = new Book();
    const r = b.period("1", { a: { amount: "1" }, b: { amount: "1" }, c: { amount: "1" } }, { capital: "3", rho: "0" });
    expect(r.lines.map((l) => s(l.attributable))).toEqual(["0.333333", "0.333333", "0.333333"]);
    expect(s(r.attributionResidual)).toBe("0.000001");
    expect(r.totalRewards.plus(r.reserveContribution).eq(r.eligibleProfit)).toBe(true);
    const loss = new Book().period("-1", { a: { amount: "1" }, b: { amount: "1" }, c: { amount: "1" } }, { capital: "3" });
    expect(loss.lines.map((l) => s(l.lossClose))).toEqual(["0.333334", "0.333334", "0.333334"]); // losses round up in magnitude
  });

  it("pays nothing for zero-profit periods and when no paper capital existed", () => {
    expect(new Book().period("0", { a: { amount: "100" } }).totalRewards.isZero()).toBe(true);
    const noCapital = new Book().period("500", { a: { amount: "100" } }, { capital: "0" });
    expect(noCapital.totalRewards.isZero()).toBe(true);
    expect(s(noCapital.lines[0]!.attributable)).toBe("0.000000");
  });

  it("holds the per-investment high-water-mark identity over a long random history", () => {
    let seed = 11;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const b = new Book();
    const totals = new Map<string, { e: Money; n: Money; r: Money; reward: Money; q: Money }>();
    for (let k = 0; k < 400; k++) {
      const allocs: Record<string, { amount: string; overlap: string }> = {};
      for (let i = 0; i < 6; i++) if (rand() < 0.6) allocs[`x${i}`] = { amount: String(1 + Math.floor(rand() * 5000)), overlap: String(Math.floor(rand() * 100)) };
      const R = m(Math.floor((rand() - 0.45) * 1e9)).div(1e6).toFixed(6);
      const r = b.period(R, allocs, { capital: "1000000", rho: "0.15" });
      expect(r.totalRewards.plus(r.reserveContribution).eq(r.eligibleProfit)).toBe(true);
      expect(r.totalRewards.lte(r.distributable)).toBe(true);
      for (const l of r.lines) {
        expect(l.lossClose.gte(0) && l.reserveClose.gte(0) && l.reward.gte(0)).toBe(true);
        // Every attribution has the sign of the pool result: a period is either a loss or a profit for everyone.
        if (!l.attributable.isZero()) expect(l.attributable.isNegative()).toBe(m(R).isNegative());
        const t = totals.get(l.allocationId) ?? { e: m(0), n: m(0), r: m(0), reward: m(0), q: m(0) };
        totals.set(l.allocationId, { e: t.e.plus(l.eligible), n: t.n.plus(l.attributable), r: t.r.plus(l.reserveApplied), reward: t.reward.plus(l.reward), q: t.q.plus(l.reserveContribution) });
      }
    }
    for (const [id, t] of totals) {
      const { lossOpen: L, reserveOpen: V } = b.state.get(id)!;
      // Σ eligible = Σ attributable + unrecovered loss + reserve used: nothing is ever paid twice.
      expect(t.e.eq(t.n.plus(L).plus(t.r)), id).toBe(true);
      // The reserve an investment owns is exactly what was withheld from it minus what absorbed its own losses.
      expect(V.eq(t.q.minus(t.r)), id).toBe(true);
    }
  });
});
