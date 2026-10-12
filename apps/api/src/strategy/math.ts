import { Decimal } from "decimal.js";
import { Money, type Money as MoneyT } from "../lib/money.js";

/**
 * Pure, exact-decimal trading math for the paper-trading engine.
 *
 * Rounding policy (always against the strategy, so results are never
 * flattered by rounding):
 *   - buy execution price rounds UP, sell execution price rounds DOWN
 *   - quantities round DOWN to the instrument's quantity scale
 *   - buy notional rounds UP, sell notional rounds DOWN (quote scale)
 *   - fees round UP
 *   - position valuation rounds DOWN
 *   - cost basis released on a partial sell rounds UP (realises less gain / more loss);
 *     a full close releases exactly the remaining cost basis
 */

const BPS = new Money(10000);
const ZERO = new Money(0);

export interface Venue {
  feeBps: MoneyT;
  slippageBps: MoneyT;
  priceScale: number;
  quantityScale: number;
  quoteScale: number;
}

export const up = (v: MoneyT, dp: number) => v.toDecimalPlaces(dp, Decimal.ROUND_UP);
export const down = (v: MoneyT, dp: number) => v.toDecimalPlaces(dp, Decimal.ROUND_DOWN);

export function execPrice(side: "buy" | "sell", mid: MoneyT, v: Venue): MoneyT {
  const factor = v.slippageBps.div(BPS);
  return side === "buy"
    ? up(mid.times(new Money(1).plus(factor)), v.priceScale)
    : down(mid.times(new Money(1).minus(factor)), v.priceScale);
}

export const feeFor = (notional: MoneyT, v: Venue) => up(notional.times(v.feeBps).div(BPS), v.quoteScale);

export interface Fill {
  side: "buy" | "sell";
  quantity: MoneyT;
  midPrice: MoneyT;
  execPrice: MoneyT;
  notional: MoneyT;
  fee: MoneyT;
  /** Cost of execution vs mid caused by slippage (informational; already inside notional). */
  slippageCost: MoneyT;
}

/**
 * Largest buy whose total cash outlay (notional + fee) does not exceed `budget`.
 * Returns null if not even one quantity unit is affordable.
 */
export function fillBuy(budget: MoneyT, mid: MoneyT, v: Venue): Fill | null {
  if (budget.lte(0)) return null;
  const px = execPrice("buy", mid, v);
  const unit = new Money(1).div(new Money(10).pow(v.quantityScale));
  let qty = down(budget.div(px.times(new Money(1).plus(v.feeBps.div(BPS)))), v.quantityScale);
  // Rounding of notional/fee can push the total a hair over budget; step down.
  for (let i = 0; i < 1000 && qty.gt(0); i++) {
    const notional = up(qty.times(px), v.quoteScale);
    const fee = feeFor(notional, v);
    if (notional.plus(fee).lte(budget)) {
      return {
        side: "buy",
        quantity: qty,
        midPrice: mid,
        execPrice: px,
        notional,
        fee,
        slippageCost: up(qty.times(px.minus(mid)), v.quoteScale),
      };
    }
    qty = qty.minus(unit);
  }
  return null;
}

/** Sell `quantity` at the venue's sell price. Returns null if proceeds would not cover the fee. */
export function fillSell(quantity: MoneyT, mid: MoneyT, v: Venue): Fill | null {
  if (quantity.lte(0)) return null;
  const px = execPrice("sell", mid, v);
  const notional = down(quantity.times(px), v.quoteScale);
  const fee = feeFor(notional, v);
  if (notional.lte(0) || notional.minus(fee).lte(0)) return null;
  return {
    side: "sell",
    quantity,
    midPrice: mid,
    execPrice: px,
    notional,
    fee,
    slippageCost: up(quantity.times(mid.minus(px)), v.quoteScale),
  };
}

/** Cost basis released when selling `sellQty` out of a position of `positionQty` with total `costBasis`. */
export function costBasisReleased(sellQty: MoneyT, positionQty: MoneyT, costBasis: MoneyT, quoteScale: number): MoneyT {
  if (sellQty.gt(positionQty)) throw new Error("cannot sell more than the position");
  if (sellQty.eq(positionQty)) return costBasis;
  const released = up(costBasis.times(sellQty).div(positionQty), quoteScale);
  return released.gt(costBasis) ? costBasis : released;
}

export interface PositionState {
  cash: MoneyT;
  quantity: MoneyT;
  costBasis: MoneyT;
}

export interface Valuation {
  positionValue: MoneyT;
  equity: MoneyT;
  unrealisedPnl: MoneyT;
}

export function value(state: PositionState, mid: MoneyT, quoteScale: number): Valuation {
  const positionValue = down(state.quantity.times(mid), quoteScale);
  const equity = state.cash.plus(positionValue);
  return { positionValue, equity, unrealisedPnl: positionValue.minus(state.costBasis) };
}

/** Apply a fill to a position state (pure). */
export function applyFill(state: PositionState, fill: Fill, quoteScale: number): { next: PositionState; released: MoneyT; realisedPnl: MoneyT } {
  if (fill.side === "buy") {
    return {
      next: {
        cash: state.cash.minus(fill.notional).minus(fill.fee),
        quantity: state.quantity.plus(fill.quantity),
        costBasis: state.costBasis.plus(fill.notional),
      },
      released: ZERO,
      realisedPnl: ZERO,
    };
  }
  const released = costBasisReleased(fill.quantity, state.quantity, state.costBasis, quoteScale);
  return {
    next: {
      cash: state.cash.plus(fill.notional).minus(fill.fee),
      quantity: state.quantity.minus(fill.quantity),
      costBasis: state.costBasis.minus(released),
    },
    released,
    realisedPnl: fill.notional.minus(released),
  };
}

export interface RiskLimits {
  maxPositionValue: MoneyT;
  maxExposureRatio: MoneyT;
  dailyLossLimit: MoneyT;
  maxDrawdownRatio: MoneyT;
}

/** Post-trade position limits. Returns the list of violated limits (empty = OK). */
export function positionLimitViolations(state: PositionState, mid: MoneyT, limits: RiskLimits, quoteScale: number): string[] {
  const { positionValue, equity } = value(state, mid, quoteScale);
  const out: string[] = [];
  if (state.cash.lt(0)) out.push("insufficient_cash");
  if (positionValue.gt(limits.maxPositionValue)) out.push("max_position_value");
  if (positionValue.gt(0) && positionValue.gt(equity.times(limits.maxExposureRatio))) out.push("max_exposure_ratio");
  return out;
}

export function drawdownRatio(peak: MoneyT, equity: MoneyT): MoneyT {
  if (peak.lte(0) || equity.gte(peak)) return ZERO;
  return peak.minus(equity).div(peak).toDecimalPlaces(12, Decimal.ROUND_UP);
}

export interface Breach {
  limit: "max_drawdown" | "daily_loss";
  observed: string;
  threshold: string;
}

/** Loss-limit monitoring. Returns the first breached limit, if any. */
export function lossBreach(equity: MoneyT, peak: MoneyT, dayStartEquity: MoneyT, limits: RiskLimits): Breach | null {
  const dd = drawdownRatio(peak, equity);
  if (dd.gte(limits.maxDrawdownRatio)) {
    return { limit: "max_drawdown", observed: dd.toFixed(), threshold: limits.maxDrawdownRatio.toFixed() };
  }
  const dayLoss = dayStartEquity.minus(equity);
  if (dayLoss.gte(limits.dailyLossLimit)) {
    return { limit: "daily_loss", observed: dayLoss.toFixed(), threshold: limits.dailyLossLimit.toFixed() };
  }
  return null;
}
