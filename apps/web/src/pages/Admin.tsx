import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { useLoad } from "../useLoad";

interface Integrity {
  ok: boolean;
  checkedAt: string;
  problems: string[];
  trialBalance: Array<{ asset: string; debitNormalTotal: string; creditNormalTotal: string }>;
}

export function AdminPage() {
  const { data, error, reload } = useLoad(() => api<Integrity>("/api/admin/ledger/integrity"));
  const [msg, setMsg] = useState<string | null>(null);

  async function settle() {
    const res = await api<{ settled: string[] }>("/api/admin/investments/settle-matured", { method: "POST", body: {} });
    setMsg(`Settled ${res.settled.length} matured investment(s).`);
    await reload();
  }

  return (
    <div className="stack">
      <h2>Admin</h2>
      <div className="card">
        <h3>Strategy engine (simulated)</h3>
        <p className="muted small">Paper-trading strategies on synthetic market data, with risk limits and the kill switch.</p>
        <Link className="button" to="/admin/strategies">
          Open strategy dashboard →
        </Link>
      </div>
      <div className="card">
        <h3>Rewards (simulated)</h3>
        <p className="muted small">Reward pools, product assignments, policies, and the reward journal (calculate, review, post).</p>
        <Link className="button" to="/admin/rewards">
          Open rewards console →
        </Link>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <div className="row spread">
          <h3>Ledger integrity</h3>
          <button onClick={() => void reload()}>Re-check</button>
        </div>
        {data && (
          <>
            <p className={data.ok ? "success" : "error"}>
              {data.ok ? "All invariants hold." : `${data.problems.length} problem(s) found.`}
            </p>
            {data.problems.length > 0 && (
              <ul>
                {data.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <table>
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Debit-normal (assets)</th>
                  <th className="num">Credit-normal (liabilities)</th>
                </tr>
              </thead>
              <tbody>
                {data.trialBalance.map((t) => (
                  <tr key={t.asset}>
                    <td>{t.asset}</td>
                    <td className="num">{t.debitNormalTotal}</td>
                    <td className="num">{t.creditNormalTotal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
      <div className="card">
        <h3>Maturity settlement</h3>
        <p className="muted small">Runs automatically every 30 seconds. Trigger manually here.</p>
        <button onClick={() => void settle()}>Settle matured investments now</button>
        {msg && <div className="success">{msg}</div>}
      </div>
    </div>
  );
}
