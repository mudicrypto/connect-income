import { Decimal } from "decimal.js";
import { badRequest } from "./errors.js";

/**
 * All money is handled as exact decimals. Never use JS `number` for amounts.
 * The database stores NUMERIC(38,18); each asset additionally has a `scale`
 * (USDT = 6) that user-entered amounts must respect.
 */
export const Money = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_DOWN, toExpNeg: -40, toExpPos: 40 });
export type Money = Decimal;

const AMOUNT_RE = /^(0|[1-9]\d{0,19})(\.\d{1,18})?$/;

/** Parse a user-supplied amount string, enforcing positivity and asset scale. */
export function parseAmount(input: unknown, scale: number): Money {
  if (typeof input !== "string" || !AMOUNT_RE.test(input)) {
    throw badRequest("invalid_amount", "Amount must be a positive decimal string, e.g. \"100.50\"");
  }
  const value = new Money(input);
  if (value.lte(0)) throw badRequest("invalid_amount", "Amount must be greater than zero");
  if (value.decimalPlaces() > scale) {
    throw badRequest("invalid_amount", `Amount supports at most ${scale} decimal places`);
  }
  return value;
}

/** Convert a NUMERIC string from Postgres into an exact decimal. */
export function fromDb(value: string | null | undefined): Money {
  return new Money(value ?? "0");
}

/** Canonical string representation with exactly `scale` decimal places. */
export function format(value: Money | string, scale: number): string {
  return new Money(value).toFixed(scale, Decimal.ROUND_DOWN);
}

export function sum(values: Array<Money | string>): Money {
  return values.reduce<Money>((acc, v) => acc.plus(v), new Money(0));
}
