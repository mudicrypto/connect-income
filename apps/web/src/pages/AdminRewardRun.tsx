import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmt, fmtDate, pct, type RewardRunDetail } from "../api";
import { useLoad } from "../useLoad";
import { SimBadge } from "./AdminStrategies";
import { RunStatus } from "./AdminRewards";

export function AdminRewardRunPage() {
  const { id = "" } = useParams();
  const { data, error, reload } = useLoad(() => api<RewardRunDetail>(`/api/admin/rewards/runs/${id}`), [id]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function act(path: string, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await api(`/api/admin/rewards/runs/${id}/${path}`, { method: "POST", body: {} });
      setMsg({ ok: true, text: ok });
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
      await reload();
    }
  }

  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const r = data.run;
  const rows: Array<[string, string, string?]> = [
    ["Source trades (realised, in period)", String(r.sourceTradeCount)],
    ["Gross realised gains", fmt(r.grossGains, 6)],
    ["Gross realised losses", `−${fmt(r.grossLosses, 6)}`],
    ["Fees", `−${fmt(r.fees, 6)}`],
    ["Net realised P&L (pool)", fmt(r.netRealised, 6), "R = G − L − F"],
    ["Customer participation", pct(r.customerFraction, 4), "time-weighted allocations ÷ paper capital"],
    ["Customer-attributable result", fmt(r.attributable, 6), r.lossModel === "investment_v2" ? "Σ ⌊R × Aᵢ / C⌋ per investment" : "⌊R × φ⌋"],
    [r.lossModel === "investment_v2" ? "Investors' losses to recover (open, Σ)" : "Loss carry-forward (open)", fmt(r.cfOpen, 6)],
    ["Recovered (not paid out)", fmt(r.cfRecovered, 6)],
    ["Reserve (open)", fmt(r.reserveOpen, 6)],
    ["Reserve applied to loss", fmt(r.reserveApplied, 6)],
    [r.lossModel === "investment_v2" ? "Investors' losses to recover (close, Σ)" : "Loss carry-forward (close)", fmt(r.cfClose, 6)],
    ["Eligible profit", fmt(r.eligibleProfit, 6)],
    ["Reserve contribution (incl. rounding residual)", fmt(r.reserveContribution, 6), `residual ${fmt(r.roundingResidual, 6)}`],
    ["Distributable", fmt(r.distributable, 6)],
    ["Total rewards", fmt(r.totalRewards, 6), "≤ distributable"],
    ...(r.lossModel === "investment_v2"
      ? ([["Attribution remainder (kept by pool)", fmt(r.attributionResidual, 6), "rounding of per-investment shares"]] as Array<[string, string, string?]>)
      : []),
  ];

  return (
    <div className="stack">
      <div className="row spread">
        <h2>
          Reward run · {r.poolCode} <SimBadge />
        </h2>
        <Link to="/admin/rewards">← Rewards</Link>
      </div>
      <div className="row wrap">
        <RunStatus status={r.status} />
        <span className="muted">
          Period {fmtDate(r.periodStart)} → {fmtDate(r.periodEnd)} · policy v{r.policyVersion} ·{" "}
          {r.lossModel === "investment_v2" ? "per-investment loss recovery" : "legacy pool-wide carry-forward"} · run {r.id}
        </span>
      </div>
      {r.error && <div className={r.status === "failed" ? "error" : "warning"}>{r.error}</div>}

      <div className="grid2">
        <div className="card">
          <h3>Calculation (simulated)</h3>
          <dl className="kv wide">
            {rows.map(([k, v, note]) => (
              <div key={k} className="kv-row">
                <dt>{k}</dt>
                <dd>
                  {v} {note && <span className="muted small">{note}</span>}
                </dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="card stack">
          <h3>Actions</h3>
          {r.status === "calculated" ? (
            <>
              <p className="muted small">
                Posting recomputes the period from source data. If anything changed it fails, and you recalculate. It then
                checks that the pool holds enough cash, and writes balanced ledger entries in one transaction.
              </p>
              <button className="primary" disabled={busy} onClick={() => void act("post", "Run posted.")}>
                Post run to ledger
              </button>
              <button disabled={busy} onClick={() => void act("cancel", "Run cancelled.")}>
                Cancel run
              </button>
            </>
          ) : (
            <p className="muted">This run is {r.status} and final.</p>
          )}
          {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
          <dl className="kv">
            <dt>Distribution entry</dt>
            <dd>
              <code className="small">{r.distributionEntryId ?? "—"}</code>
            </dd>
            <dt>Reserve release entry</dt>
            <dd>
              <code className="small">{r.reserveReleaseEntryId ?? "—"}</code>
            </dd>
            <dt>Posted</dt>
            <dd>{r.postedAt ? fmtDate(r.postedAt) : "—"}</dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h3>Recipients ({data.lines.length})</h3>
        {data.lines.length === 0 ? (
          <p className="muted">No allocations overlapped this period.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Investor</th>
                  <th>Investment</th>
                  <th className="num">Allocation</th>
                  <th className="num">Weight</th>
                  {r.lossModel === "investment_v2" && (
                    <>
                      <th className="num">Share of result</th>
                      <th className="num">Recovered</th>
                      <th className="num">Loss to recover</th>
                      <th className="num">Reserve ±</th>
                      <th className="num">Reserve owned</th>
                    </>
                  )}
                  <th className="num">Reward</th>
                  <th>Released</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.userEmail}</td>
                    <td>
                      <code className="small">{l.investmentId.slice(0, 8)}</code>
                    </td>
                    <td className="num">{fmt(l.allocationAmount)}</td>
                    <td className="num">{pct(l.weightFraction, 4)}</td>
                    {r.lossModel === "investment_v2" && (
                      <>
                        <td className="num">{fmt(l.attributable ?? "0", 6)}</td>
                        <td className="num">{fmt(l.lossRecovered ?? "0", 6)}</td>
                        <td className="num">{fmt(l.lossClose ?? "0", 6)}</td>
                        <td className="num">
                          +{fmt(l.reserveContribution ?? "0", 6)} / −{fmt(l.reserveApplied ?? "0", 6)}
                        </td>
                        <td className="num">{fmt(l.reserveClose ?? "0", 6)}</td>
                      </>
                    )}
                    <td className="num">{fmt(l.reward, 6)}</td>
                    <td>{l.releasedAt ? fmtDate(l.releasedAt) : <span className="muted">at maturity</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.sources.length > 0 && (
        <div className="card">
          <h3>Source trades (simulated)</h3>
          <table>
            <thead>
              <tr>
                <th>Tick</th>
                <th>Side</th>
                <th className="num">Realised P&amp;L</th>
                <th className="num">Fee</th>
                <th>Ledger entry</th>
              </tr>
            </thead>
            <tbody>
              {data.sources.map((s) => (
                <tr key={s.id}>
                  <td>#{s.tickSeq}</td>
                  <td>{s.side}</td>
                  <td className="num">{fmt(s.realisedPnl, 6)}</td>
                  <td className="num">{fmt(s.fee, 6)}</td>
                  <td>
                    <code className="small">{s.entryId.slice(0, 8)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
