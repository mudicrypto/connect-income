import { Decimal } from "decimal.js";
import { Money, type Money as MoneyT } from "../lib/money.js";

/**
 * Pure reward calculation. Implements docs/rewards-accounting.md section 3
 * exactly; any change here must be reflected there (and vice versa).
 */

export interface CalcAllocation {
  allocationId: string;
  investmentId: string;
  userId: string;
  amount: MoneyT;
  /** Overlap of the allocation with the period, in microseconds (integer). */
  overlapUs: MoneyT;
}

export interface CalcInput {
  trades: Array<{ realisedPnl: MoneyT; fee: MoneyT }>;
  /** ∫ paper capital dt over the period, USDT·µs. */
  capitalIntegral: MoneyT;
  allocations: CalcAllocation[];
  cfOpen: MoneyT;
  reserveOpen: MoneyT;
  reserveRatio: MoneyT;
  /** Asset scale (USDT = 6). */
  scale: number;
}

export interface CalcLine extends CalcAllocation {
  weightedAllocation: MoneyT;
  weightFraction: MoneyT;
  reward: MoneyT;
}

export interface CalcResult {
  sourceTradeCount: number;
  grossGains: MoneyT;
  grossLosses: MoneyT;
  fees: MoneyT;
  netRealised: MoneyT;
  capitalIntegral: MoneyT;
  allocationIntegral: MoneyT;
  customerFraction: MoneyT;
  attributable: MoneyT;
  cfOpen: MoneyT;
  cfRecovered: MoneyT;
  cfClose: MoneyT;
  reserveOpen: MoneyT;
  reserveApplied: MoneyT;
  eligibleProfit: MoneyT;
  reserveContribution: MoneyT;
  roundingResidual: MoneyT;
  distributable: MoneyT;
  totalRewards: MoneyT;
  lines: CalcLine[];
}

const ZERO = new Money(0);
const floorTo = (v: MoneyT, dp: number) => v.toDecimalPlaces(dp, Decimal.ROUND_FLOOR);
const ceilTo = (v: MoneyT, dp: number) => v.toDecimalPlaces(dp, Decimal.ROUND_CEIL);

export function calculateRewards(input: CalcInput): CalcResult {
  const q = input.scale;
  if (input.cfOpen.lt(0) || input.reserveOpen.lt(0)) throw new Error("carry-forward and reserve cannot be negative");
  if (input.reserveRatio.lt(0) || input.reserveRatio.gte(1)) throw new Error("reserve ratio must be in [0, 1)");

  // 1. Source P&L (realised only).
  let grossGains = ZERO;
  let grossLosses = ZERO;
  let fees = ZERO;
  for (const t of input.trades) {
    if (t.realisedPnl.gt(0)) grossGains = grossGains.plus(t.realisedPnl);
    else grossLosses = grossLosses.plus(t.realisedPnl.abs());
    fees = fees.plus(t.fee);
  }
  const netRealised = grossGains.minus(grossLosses).minus(fees);

  // 2. Customer participation (time-weighted).
  const lines0 = input.allocations
    .filter((a) => a.overlapUs.gt(0))
    .map((a) => ({ ...a, weightedAllocation: a.amount.times(a.overlapUs) }));
  const allocationIntegral = lines0.reduce<MoneyT>((s, l) => s.plus(l.weightedAllocation), ZERO);
  let ratio = input.capitalIntegral.gt(0) ? allocationIntegral.div(input.capitalIntegral) : ZERO;
  if (ratio.gt(1)) ratio = new Money(1);

  // 3. Customer-attributable result, rounded toward -infinity.
  const attributable = floorTo(netRealised.times(ratio), q);

  // 4. Carry-forward and reserve.
  let cfRecovered = ZERO;
  let cfClose = input.cfOpen;
  let reserveApplied = ZERO;
  let eligibleProfit = ZERO;
  if (attributable.lte(0)) {
    const loss = attributable.neg();
    reserveApplied = Money.min(input.reserveOpen, loss);
    cfClose = input.cfOpen.plus(loss).minus(reserveApplied);
  } else {
    cfRecovered = Money.min(attributable, input.cfOpen);
    cfClose = input.cfOpen.minus(cfRecovered);
    eligibleProfit = attributable.minus(cfRecovered);
  }

  // 5. Reserve contribution and distributable amount.
  const reserveBase = Money.min(eligibleProfit, ceilTo(eligibleProfit.times(input.reserveRatio), q));
  const distributable = eligibleProfit.minus(reserveBase);

  // 6. Pro-rata allocation, rounded down; 7. residual to reserve.
  const lines: CalcLine[] = lines0.map((l) => ({
    ...l,
    weightFraction: l.weightedAllocation.div(allocationIntegral).toDecimalPlaces(18, Decimal.ROUND_DOWN),
    reward: floorTo(distributable.times(l.weightedAllocation).div(allocationIntegral), q),
  }));
  const totalRewards = lines.reduce<MoneyT>((s, l) => s.plus(l.reward), ZERO);
  const roundingResidual = distributable.minus(totalRewards);
  if (roundingResidual.lt(0)) throw new Error("rewards exceed distributable amount"); // impossible by construction
  const reserveContribution = reserveBase.plus(roundingResidual);

  return {
    sourceTradeCount: input.trades.length,
    grossGains,
    grossLosses,
    fees,
    netRealised,
    capitalIntegral: input.capitalIntegral,
    allocationIntegral,
    customerFraction: ratio.toDecimalPlaces(18, Decimal.ROUND_DOWN),
    attributable,
    cfOpen: input.cfOpen,
    cfRecovered,
    cfClose,
    reserveOpen: input.reserveOpen,
    reserveApplied,
    eligibleProfit,
    reserveContribution,
    roundingResidual,
    distributable,
    totalRewards,
    lines,
  };
}

/** Time integral of a step function of capital over [start, end), all times in µs. */
export function capitalIntegral(
  changes: Array<{ atUs: MoneyT; delta: MoneyT }>,
  startUs: MoneyT,
  endUs: MoneyT,
): MoneyT {
  const sorted = [...changes].sort((a, b) => a.atUs.comparedTo(b.atUs));
  let level = ZERO;
  for (const c of sorted) if (c.atUs.lte(startUs)) level = level.plus(c.delta);
  let cursor = startUs;
  let total = ZERO;
  for (const c of sorted) {
    if (c.atUs.lte(startUs)) continue;
    if (c.atUs.gte(endUs)) break;
    total = total.plus(level.times(c.atUs.minus(cursor)));
    level = level.plus(c.delta);
    cursor = c.atUs;
  }
  return total.plus(level.times(endUs.minus(cursor)));
}
