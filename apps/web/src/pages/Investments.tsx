import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmt, fmtDate, pct, type Investment, type RewardStatement } from "../api";
import { useLoad } from "../useLoad";

function timeLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return "due — settling";
  const d = Math.floor(ms / 86400_000);
  const h = Math.floor((ms % 86400_000) / 3600_000);
  const m = Math.ceil((ms % 3600_000) / 60_000);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function InvestmentsPage() {
  const { data, error, reload } = useLoad(() => api<{ investments: Investment[] }>("/api/investments"));
  const all = data?.investments ?? [];
  const active = all.filter((i) => i.status === "active");
  const matured = all.filter((i) => i.status === "matured");

  return (
    <div className="stack">
      <div className="row spread">
        <h2>Investments</h2>
        <div className="row">
          <button onClick={() => void reload()}>Refresh</button>
          <Link className="button primary" to="/invest">
            New investment
          </Link>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h3>Active ({active.length})</h3>
        {active.length === 0 ? (
          <p className="muted">No active investments.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Principal</th>
                <th>Started</th>
                <th>Maturity date</th>
                <th>Remaining</th>
                <th>Simulated pool</th>
                <th className="num">Rewards pending</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {active.map((i) => (
                <InvestmentRow key={i.id} i={i}>
                  <td>{i.productName}</td>
                  <td className="num">{fmt(i.principal, 6)} {i.asset}</td>
                  <td>{fmtDate(i.startAt)}</td>
                  <td>
                    <strong>{fmtDate(i.maturityAt)}</strong>
                  </td>
                  <td>{timeLeft(i.maturityAt)}</td>
                  <td>{i.pool ? i.pool.code : <span className="muted">none</span>}</td>
                  <td className="num">{i.pool ? fmt(i.rewardsPending, 6) : "—"}</td>
                </InvestmentRow>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <div className="card">
        <h3>Matured ({matured.length})</h3>
        {matured.length === 0 ? (
          <p className="muted">None yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Product</th>
                <th className="num">Principal returned</th>
                <th>Maturity date</th>
                <th>Settled</th>
                <th>Simulated pool</th>
                <th className="num">Rewards released</th>
                <th className="num">Rewards pending</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {matured.map((i) => (
                <InvestmentRow key={i.id} i={i}>
                  <td>{i.productName}</td>
                  <td className="num">{fmt(i.principal, 6)} {i.asset}</td>
                  <td>{fmtDate(i.maturityAt)}</td>
                  <td>{i.settledAt ? fmtDate(i.settledAt) : "—"}</td>
                  <td>{i.pool ? i.pool.code : <span className="muted">none</span>}</td>
                  <td className="num">{i.pool ? fmt(i.rewardsReleased, 6) : "—"}</td>
                  <td className="num">{i.pool ? fmt(i.rewardsPending, 6) : "—"}</td>
                </InvestmentRow>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** A table row with an expandable per-period reward statement (simulated). */
function InvestmentRow({ i, children }: { i: Investment; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [statement, setStatement] = useState<RewardStatement | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    if (!open && !statement) {
      try {
        setStatement(await api<RewardStatement>(`/api/investments/${i.id}/rewards`));
      } catch (e) {
        setError((e as Error).message);
      }
    }
    setOpen((o) => !o);
  }

  return (
    <>
      <tr>
        {children}
        <td>{i.pool && <button className="link" onClick={() => void toggle()}>{open ? "Hide" : "Statement"}</button>}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={20} className="statement">
            {error && <div className="error">{error}</div>}
            {statement && (
              <>
                <div className="muted small">
                  Simulated pool {statement.investment.poolCode}: rewards come only from the pool's realised simulated profit for
                  each closed period. Earlier losses must be recovered before anything is paid. Not guaranteed.
                </div>
                {statement.periods.length === 0 ? (
                  <p className="muted">No reward periods posted yet.</p>
                ) : (
                  <table>
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th className="num">Pool net realised</th>
                        <th className="num">Your weight</th>
                        <th className="num">Your reward</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {statement.periods.map((p) => (
                        <tr key={p.runId}>
                          <td>
                            {fmtDate(p.periodStart)} → {fmtDate(p.periodEnd)}
                          </td>
                          <td className="num">{fmt(p.poolNetRealised)}</td>
                          <td className="num">{pct(p.weightFraction)}</td>
                          <td className="num">{fmt(p.reward, 6)}</td>
                          <td>
                            {/^0(\.0+)?$/.test(p.reward) ? (
                              <span className="muted">no reward (no eligible profit)</span>
                            ) : p.releasedAt ? (
                              "released"
                            ) : (
                              "pending until maturity"
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
