import { z } from "zod";
import { Money, type Money as MoneyT } from "../lib/money.js";

/**
 * Deterministic strategy decision rules. Pure functions: same inputs, same
 * decision. They only express a *desired* position value; sizing, risk
 * limits and execution are enforced by the engine on the server.
 */

export type StrategyType = "trading" | "staking" | "lending";

export const INSTRUMENT_KIND_FOR: Record<StrategyType, "spot" | "staking" | "lending"> = {
  trading: "spot",
  staking: "staking",
  lending: "lending",
};

const ratio = z
  .string()
  .regex(/^(0(\.\d{1,8})?|1(\.0{1,8})?)$/, "must be a decimal ratio between 0 and 1, e.g. \"0.5\"");
const amount = z.string().regex(/^\d{1,20}(\.\d{1,6})?$/, "must be a decimal string");

export const tradingParamsSchema = z
  .object({
    lookbackTicks: z.number().int().min(1).max(500).default(24),
    entryThresholdBps: z.number().int().min(-10000).max(10000).default(100),
    exitThresholdBps: z.number().int().min(-10000).max(10000).default(-50),
    targetExposure: ratio.default("0.5"),
    minTradeValue: amount.default("10"),
  })
  .strict();

export const rebalanceParamsSchema = z
  .object({
    targetExposure: ratio.default("0.8"),
    rebalanceBand: ratio.default("0.05"),
    minTradeValue: amount.default("10"),
  })
  .strict();

export type TradingParams = z.infer<typeof tradingParamsSchema>;
export type RebalanceParams = z.infer<typeof rebalanceParamsSchema>;

export function parseParams(type: StrategyType, raw: unknown): TradingParams | RebalanceParams {
  return type === "trading" ? tradingParamsSchema.parse(raw ?? {}) : rebalanceParamsSchema.parse(raw ?? {});
}

export interface DecisionInput {
  type: StrategyType;
  params: TradingParams | RebalanceParams;
  /** Current mid price. */
  price: MoneyT;
  /** Mid price `lookbackTicks` ticks ago, if available (trading only). */
  lookbackPrice: MoneyT | null;
  equity: MoneyT;
  positionValue: MoneyT;
  positionQty: MoneyT;
}

export type Decision =
  | { action: "hold"; note?: string }
  | { action: "buy"; value: MoneyT; reason: "signal" | "rebalance" }
  | { action: "sell"; value: MoneyT; all: boolean; reason: "signal" | "rebalance" };

export function decide(input: DecisionInput): Decision {
  if (input.equity.lte(0)) return { action: "hold", note: "no_capital" };
  const minTrade = new Money(input.params.minTradeValue);

  if (input.type === "trading") {
    const p = input.params as TradingParams;
    if (!input.lookbackPrice) return { action: "hold", note: "insufficient_history" };
    const momentumBps = input.price.div(input.lookbackPrice).minus(1).times(10000);
    if (input.positionQty.gt(0) && momentumBps.lte(p.exitThresholdBps)) {
      return { action: "sell", value: input.positionValue, all: true, reason: "signal" };
    }
    if (input.positionQty.isZero() && momentumBps.gte(p.entryThresholdBps)) {
      const value = input.equity.times(p.targetExposure);
      return value.gte(minTrade) ? { action: "buy", value, reason: "signal" } : { action: "hold", note: "below_min_trade" };
    }
    return { action: "hold" };
  }

  const p = input.params as RebalanceParams;
  const target = input.equity.times(p.targetExposure);
  const delta = target.minus(input.positionValue);
  if (delta.abs().lte(input.equity.times(p.rebalanceBand)) || delta.abs().lt(minTrade)) return { action: "hold" };
  if (delta.gt(0)) return { action: "buy", value: delta, reason: "rebalance" };
  return { action: "sell", value: delta.abs(), all: target.isZero(), reason: "rebalance" };
}
