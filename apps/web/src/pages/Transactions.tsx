import { useEffect, useState } from "react";
import { api, fmt, fmtDate, type Transaction } from "../api";

const TYPE_LABELS: Record<string, string> = {
  simulated_deposit: "Simulated deposit",
  investment_open: "Investment opened",
  investment_mature: "Investment matured",
};

export function TransactionTable({ items }: { items: Transaction[] }) {
  if (items.length === 0) return <p className="muted">No transactions yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th>Date</th>
          <th>Type</th>
          <th>Account</th>
          <th className="num">Amount</th>
          <th className="num">Balance after</th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={t.postingId}>
            <td>{fmtDate(t.createdAt)}</td>
            <td title={t.description}>{TYPE_LABELS[t.entryType] ?? t.entryType}</td>
            <td>{t.account === "available" ? "Available" : "Invested"}</td>
            <td className={`num ${t.amount.startsWith("-") ? "neg" : "pos"}`}>
              {t.amount.startsWith("-") ? "" : "+"}
              {fmt(t.amount, 6)} {t.asset}
            </td>
            <td className="num">{fmt(t.balanceAfter, 6)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TransactionsPage() {
  const [items, setItems] = useState<Transaction[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(before?: string) {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ limit: "50", ...(before ? { before } : {}) });
      const res = await api<{ items: Transaction[]; nextCursor: string | null }>(`/api/transactions?${qs}`);
      setItems((prev) => (before ? [...prev, ...res.items] : res.items));
      setCursor(res.nextCursor);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className="stack">
      <h2>Transaction history</h2>
      <p className="muted small">
        Every line is a posting in the double-entry ledger. An investment appears as two lines: funds leave your
        available balance and enter your invested principal.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <TransactionTable items={items} />
        {cursor && (
          <button disabled={loading} onClick={() => void load(cursor)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}
