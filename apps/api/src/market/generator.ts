import { createHash } from "node:crypto";
import { Decimal } from "decimal.js";
import { Money, type Money as MoneyT } from "../lib/money.js";

/**
 * Deterministic synthetic price generator. SIMULATED DATA ONLY.
 *
 * Randomness for tick `seq` is derived from sha256(seed:seq:stream), so the
 * series is identical no matter how generation is batched, restarted or
 * repeated. All arithmetic is exact decimal; the uniform draw is an integer
 * in [0, 2^32) divided by 2^32.
 */
export interface GeneratorParams {
  seed: string;
  startPrice: string;
  driftBps: string;
  volatilityBps: string;
  shockProbability: string;
  shockBps: string;
  priceScale: number;
}

const TWO_POW_32 = new Money(2).pow(32);
const BPS = new Money(10000);

export function uniform(seed: string, seq: bigint | number, stream: string): MoneyT {
  const digest = createHash("sha256").update(`${seed}:${seq}:${stream}`).digest();
  return new Money(digest.readUInt32BE(0)).div(TWO_POW_32);
}

/** Per-tick return (as a fraction) for tick `seq`. */
export function tickReturn(p: GeneratorParams, seq: bigint | number): MoneyT {
  const noise = uniform(p.seed, seq, "noise").times(2).minus(1); // [-1, 1)
  let bps = new Money(p.driftBps).plus(new Money(p.volatilityBps).times(noise));
  if (uniform(p.seed, seq, "shock").lt(p.shockProbability)) bps = bps.minus(p.shockBps);
  return bps.div(BPS);
}

/** Price at `seq` given the price at `seq - 1`. Rounded half-even to the instrument's price scale. */
export function nextPrice(prev: MoneyT | string, p: GeneratorParams, seq: bigint | number): MoneyT {
  const price = new Money(prev).times(new Money(1).plus(tickReturn(p, seq))).toDecimalPlaces(p.priceScale, Decimal.ROUND_HALF_EVEN);
  // Keep the series strictly positive even after extreme shocks.
  const floor = new Money(1).div(new Money(10).pow(p.priceScale));
  return price.lt(floor) ? floor : price;
}
