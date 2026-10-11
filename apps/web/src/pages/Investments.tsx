import { Link } from "react-router-dom";
import { api, fmt, fmtDate, type Investment } from "../api";
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
              </tr>
            </thead>
            <tbody>
              {active.map((i) => (
                <tr key={i.id}>
                  <td>{i.productName}</td>
                  <td className="num">{fmt(i.principal, 6)} {i.asset}</td>
                  <td>{fmtDate(i.startAt)}</td>
                  <td>
                    <strong>{fmtDate(i.maturityAt)}</strong>
                  </td>
                  <td>{timeLeft(i.maturityAt)}</td>
                </tr>
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
              </tr>
            </thead>
            <tbody>
              {matured.map((i) => (
                <tr key={i.id}>
                  <td>{i.productName}</td>
                  <td className="num">{fmt(i.principal, 6)} {i.asset}</td>
                  <td>{fmtDate(i.maturityAt)}</td>
                  <td>{i.settledAt ? fmtDate(i.settledAt) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
