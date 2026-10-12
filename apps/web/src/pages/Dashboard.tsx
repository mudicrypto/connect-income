import { useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, fmt, fmtDate, newKey, type Balance, type Transaction } from "../api";
import { useLoad } from "../useLoad";
import { TransactionTable } from "./Transactions";

interface Dashboard {
  balances: Balance[];
  activeInvestmentCount: number;
  nextMaturityAt: string | null;
  recentTransactions: Transaction[];
}

export function DashboardPage() {
  const { data, error, reload } = useLoad(() => api<Dashboard>("/api/dashboard"));
  const usdt = data?.balances.find((b) => b.asset === "USDT");

  return (
    <div className="stack">
      <h2>Dashboard</h2>
      {error && <div className="error">{error}</div>}
      <div className="grid4">
        <Stat label="Available" value={usdt ? `${fmt(usdt.available)} USDT` : "…"} />
        <Stat label="Invested principal" value={usdt ? `${fmt(usdt.invested)} USDT` : "…"} />
        <Stat label="Rewards pending (simulated)" value={usdt ? `${fmt(usdt.rewardPending, 6)} USDT` : "…"} />
        <Stat label="Total" value={usdt ? `${fmt(usdt.total)} USDT` : "…"} />
      </div>
      <p className="muted small">
        Pending rewards come only from realised profit of a simulated strategy pool, are variable (often zero) and are released
        when the investment matures. They are never guaranteed.
      </p>
      <div className="grid2">
        <SimulatedDeposit onDone={reload} />
        <div className="card">
          <h3>Investments</h3>
          <p>
            <strong>{data?.activeInvestmentCount ?? "…"}</strong> active investment(s).
          </p>
          <p className="muted">Next maturity: {data?.nextMaturityAt ? fmtDate(data.nextMaturityAt) : "—"}</p>
          <div className="row">
            <Link className="button primary" to="/invest">
              New investment
            </Link>
            <Link className="button" to="/investments">
              View investments
            </Link>
          </div>
        </div>
      </div>
      <div className="card">
        <div className="row spread">
          <h3>Recent activity</h3>
          <Link to="/transactions">All transactions →</Link>
        </div>
        <TransactionTable items={data?.recentTransactions ?? []} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function SimulatedDeposit({ onDone }: { onDone: () => Promise<void> }) {
  const [amount, setAmount] = useState("1000");
  const [attempt, setAttempt] = useState(0);
  // One key per distinct submission; a retry of the same submission reuses it.
  const idempotencyKey = useMemo(() => newKey(), [amount, attempt]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await api<{ amount: string }>("/api/deposits/simulated", { method: "POST", body: { amount }, idempotencyKey });
      setMsg({ ok: true, text: `Deposited ${fmt(res.amount)} simulated USDT.` });
      setAttempt((a) => a + 1);
      await onDone();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Simulated deposit</h3>
      <p className="muted small">Adds simulated USDT to your available balance. Not real funds.</p>
      <label>
        Amount (USDT)
        <input value={amount} onChange={(e) => setAmount(e.target.value.trim())} inputMode="decimal" pattern="\d+(\.\d{1,6})?" required />
      </label>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      <button className="primary" disabled={busy}>
        Deposit simulated USDT
      </button>
    </form>
  );
}
