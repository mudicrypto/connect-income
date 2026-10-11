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
