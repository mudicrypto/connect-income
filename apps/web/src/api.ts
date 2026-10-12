export interface User {
  id: string;
  email: string;
  displayName: string;
  role: "user" | "admin";
}
export interface Balance {
  asset: string;
  available: string;
  invested: string;
  total: string;
}
export interface Product {
  id: string;
  code: string;
  name: string;
  description: string;
  asset: string;
  termMinutes: number;
  minAmount: string;
  maxAmount: string | null;
  strategyDescription: string;
  riskDisclosure: string;
  devOnly: boolean;
}
export interface Investment {
  id: string;
  productCode: string;
  productName: string;
  asset: string;
  principal: string;
  status: "active" | "matured";
  startAt: string;
  maturityAt: string;
  settledAt: string | null;
}
export interface Transaction {
  postingId: string;
  entryId: string;
  entryType: string;
  description: string;
  account: "available" | "invested";
  asset: string;
  amount: string;
  balanceAfter: string;
  createdAt: string;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.message ?? `Request failed (${res.status})`);
  }
  return data as T;
}

/** Group the integer part of a decimal string without converting to a float. */
export function fmt(amount: string, decimals = 2): string {
  const neg = amount.startsWith("-");
  const [int = "0", frac = ""] = amount.replace("-", "").split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  // Truncate (never round up) for display.
  const shown = decimals > 0 ? `${grouped}.${frac.padEnd(decimals, "0").slice(0, decimals)}` : grouped;
  return (neg ? "-" : "") + shown;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function termLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} days`;
  if (minutes % 60 === 0) return `${minutes / 60} hours`;
  return `${minutes} minutes`;
}

export const newKey = () => crypto.randomUUID();

// ---------------------------------------------------------------------------
// Strategy engine (admin, SIMULATED)
// ---------------------------------------------------------------------------
export interface StrategySummary {
  id: string;
  code: string;
  name: string;
  description: string;
  type: "trading" | "staking" | "lending";
  status: "active" | "paused";
  pauseReason: string | null;
  pausedAt: string | null;
  instrument: { symbol: string; name: string };
  asset: string;
  limits: { maxAllocation: string; maxPositionValue: string; maxExposureRatio: string; dailyLossLimit: string; maxDrawdownRatio: string };
  params: Record<string, unknown>;
  lastTickSeq: string;
  markPrice: string | null;
  markSimulatedAt: string | null;
  allocatedCapital: string;
  cash: string;
  positionQty: string;
  costBasis: string;
  positionValue: string;
  equity: string;
  realisedGain: string;
  realisedLoss: string;
  realisedPnl: string;
  fees: string;
  unrealisedPnl: string;
  netPnl: string;
  exposureRatio: string;
  peakEquity: string;
  drawdownRatio: string;
  dayPnl: string;
  tradeCount: number;
  breachCount: number;
}
export interface StrategyTrade {
  id: string;
  tickSeq: string;
  side: "buy" | "sell";
  reason: string;
  quantity: string;
  midPrice: string;
  execPrice: string;
  notional: string;
  fee: string;
  slippageCost: string;
  realisedPnl: string;
  positionQtyAfter: string;
  createdAt: string;
}
export interface StrategyEvent {
  id: string;
  eventType: string;
  tickSeq: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}
export interface StrategyDetail {
  strategy: StrategySummary;
  trades: StrategyTrade[];
  events: StrategyEvent[];
  equitySeries: Array<{ tickSeq: string; price: string; equity: string; drawdownRatio: string; status: string }>;
}
export interface EngineState {
  killSwitch: { enabled: boolean; reason: string | null; updatedAt: string };
  runs: Array<{ id: string; trigger: string; status: string; ticksProcessed: number; trades: number; error: string | null; startedAt: string }>;
  instruments: Array<{ id: string; symbol: string; name: string; kind: string; dataSource: string; feeBps: string; slippageBps: string; latestSeq: string | null; latestPrice: string | null; latestSimulatedAt: string | null }>;
}

/** Ratio string ("0.123456") to a percent string ("12.34%") without floating point. */
export function pct(ratio: string, decimals = 2): string {
  const neg = ratio.startsWith("-");
  const [int = "0", rawFrac = ""] = ratio.replace("-", "").split(".");
  const frac = rawFrac.padEnd(decimals + 2, "0");
  // Shift the decimal point two places right, truncating (never rounding up).
  const intPart = (int + frac.slice(0, 2)).replace(/^0+(?=\d)/, "");
  const fracPart = frac.slice(2, 2 + decimals);
  return `${neg ? "-" : ""}${intPart}${decimals > 0 ? "." + fracPart : ""}%`;
}

/** Signed money display: "+12.34" / "-5.00". */
export function signed(amount: string, decimals = 2): string {
  return amount.startsWith("-") ? fmt(amount, decimals) : `+${fmt(amount, decimals)}`;
}
