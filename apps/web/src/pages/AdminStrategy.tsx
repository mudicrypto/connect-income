import { useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmt, fmtDate, newKey, pct, type StrategyDetail } from "../api";
import { useLoad } from "../useLoad";
import { PnlCell, SimBadge, StatusBadge } from "./AdminStrategies";

const EVENT_LABELS: Record<string, string> = {
  created: "Created",
  paused: "Paused",
  resumed: "Resumed",
  capital_allocated: "Paper capital allocated",
  risk_breach: "⚠ Risk limit breached",
  order_clipped: "Order clipped by limits",
  order_rejected: "Order rejected by limits",
};

export function AdminStrategyPage() {
  const { id = "" } = useParams();
  const { data, error, reload } = useLoad(() => api<StrategyDetail>(`/api/admin/strategies/${id}`), [id]);
  if (error) return <div className="error">{error}</div>;
  if (!data) return <div className="muted">Loading…</div>;
  const s = data.strategy;

  return (
    <div className="stack">
      <div className="row spread">
        <h2>
          {s.code}: {s.name} <SimBadge />
        </h2>
        <Link to="/admin/strategies">← All strategies</Link>
      </div>
      <div className="row wrap">
        <StatusBadge status={s.status} reason={s.pauseReason} />
        <span className="muted">
          {s.type} · {s.instrument.symbol} · last synthetic tick #{s.lastTickSeq}
          {s.markSimulatedAt ? ` (simulated time ${fmtDate(s.markSimulatedAt)})` : ""}
        </span>
      </div>
      {s.status === "paused" && s.pauseReason && (
        <div className={s.pauseReason.startsWith("Auto-paused") ? "error" : "warning"}>Pause reason: {s.pauseReason}</div>
      )}
      {s.description && <p className="muted">{s.description}</p>}

      <div className="grid4">
        <Tile label="Allocated paper capital" value={fmt(s.allocatedCapital)} />
        <Tile label="Equity" value={fmt(s.equity)} />
        <Tile label="Net P&L" value={<PnlCell value={s.netPnl} />} />
        <Tile label="Realised P&L" value={<PnlCell value={s.realisedPnl} />} />
        <Tile label="Unrealised P&L" value={<PnlCell value={s.unrealisedPnl} />} />
        <Tile label="Fees paid" value={fmt(s.fees)} />
        <Tile label="Exposure" value={`${fmt(s.positionValue)} · ${pct(s.exposureRatio)}`} />
        <Tile label="Current drawdown" value={pct(s.drawdownRatio)} sub={`limit ${pct(s.limits.maxDrawdownRatio)}`} />
        <Tile label="Today's P&L (simulated day)" value={<PnlCell value={s.dayPnl} />} sub={`limit −${fmt(s.limits.dailyLossLimit)}`} />
      </div>
      <p className="muted small">
        All figures are SIMULATED, in USDT. Realised P&amp;L is booked in the strategy's own ledger accounts. Unrealised
        P&amp;L is a mark-to-market valuation at the last synthetic price and is not booked.
      </p>

      <EquityChart series={data.equitySeries} />

      <div className="grid2">
        <Controls detail={data} onChange={reload} />
        <div className="card">
          <h3>Risk limits (enforced server-side)</h3>
          <dl className="kv">
            <dt>Max allocation</dt>
            <dd>{fmt(s.limits.maxAllocation)} USDT</dd>
            <dt>Max position value</dt>
            <dd>{fmt(s.limits.maxPositionValue)} USDT</dd>
            <dt>Max exposure</dt>
            <dd>{pct(s.limits.maxExposureRatio)} of equity</dd>
            <dt>Daily loss limit</dt>
            <dd>{fmt(s.limits.dailyLossLimit)} USDT</dd>
            <dt>Max drawdown</dt>
            <dd>{pct(s.limits.maxDrawdownRatio)}</dd>
            <dt>Position</dt>
            <dd>
              {s.positionQty} units · cost basis {fmt(s.costBasis)}
            </dd>
            <dt>Parameters</dt>
            <dd>
              <code className="small">{JSON.stringify(s.params)}</code>
            </dd>
          </dl>
        </div>
      </div>

      <div className="card">
        <h3>
          Trade history <SimBadge />
        </h3>
        {data.trades.length === 0 ? (
          <p className="muted">No simulated trades yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Tick</th>
                  <th>Side</th>
                  <th>Reason</th>
                  <th className="num">Quantity</th>
                  <th className="num">Mid</th>
                  <th className="num">Exec price</th>
                  <th className="num">Notional</th>
                  <th className="num">Fee</th>
                  <th className="num">Slippage</th>
                  <th className="num">Realised P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {data.trades.map((t) => (
                  <tr key={t.id}>
                    <td>#{t.tickSeq}</td>
                    <td className={t.side === "buy" ? "pos" : "neg"}>{t.side.toUpperCase()}</td>
                    <td className={t.reason === "risk_liquidation" ? "neg" : ""}>{t.reason.replace("_", " ")}</td>
                    <td className="num">{fmt(t.quantity, 8)}</td>
                    <td className="num">{fmt(t.midPrice, 4)}</td>
                    <td className="num">{fmt(t.execPrice, 4)}</td>
                    <td className="num">{fmt(t.notional)}</td>
                    <td className="num">{fmt(t.fee, 6)}</td>
                    <td className="num">{fmt(t.slippageCost, 6)}</td>
                    <td className="num">{t.side === "sell" ? <PnlCell value={t.realisedPnl} /> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <h3>Events, risk breaches and pause reasons</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Recorded</th>
                <th>Tick</th>
                <th>Event</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id} className={e.eventType === "risk_breach" ? "row-breach" : ""}>
                  <td>{fmtDate(e.createdAt)}</td>
                  <td>{e.tickSeq ? `#${e.tickSeq}` : "—"}</td>
                  <td>{EVENT_LABELS[e.eventType] ?? e.eventType}</td>
                  <td>
                    <code className="small">{JSON.stringify(e.details)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Tile({ label, value, sub }: { label: string; value: React.ReactNode; sub?: string }) {
  return (
    <div className="card stat">
      <div className="muted small">{label} · simulated</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="muted small">{sub}</div>}
    </div>
  );
}

function Controls({ detail, onChange }: { detail: StrategyDetail; onChange: () => Promise<void> }) {
  const s = detail.strategy;
  const [reason, setReason] = useState("");
  const [amount, setAmount] = useState("10000");
  const [attempt, setAttempt] = useState(0);
  const idempotencyKey = useMemo(() => newKey(), [amount, attempt]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    try {
      await fn();
      setMsg({ ok: true, text: ok });
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  function allocate(e: FormEvent) {
    e.preventDefault();
    void act(async () => {
      await api(`/api/admin/strategies/${s.id}/allocations`, { method: "POST", body: { amount }, idempotencyKey });
      setAttempt((a) => a + 1);
    }, `Allocated ${amount} simulated paper USDT.`);
  }

  return (
    <div className="card stack">
      <h3>Controls</h3>
      {s.status === "active" ? (
        <div className="stack">
          <label>
            Pause reason
            <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="optional" />
          </label>
          <button
            onClick={() => void act(() => api(`/api/admin/strategies/${s.id}/pause`, { method: "POST", body: { reason } }), "Strategy paused.")}
          >
            ❚❚ Pause strategy (no new positions)
          </button>
        </div>
      ) : (
        <div className="stack">
          <p className="muted small">
            Resuming resets the drawdown and daily-loss baselines to current equity. This acknowledges any loss that caused
            an automatic pause.
          </p>
          <button
            className="primary"
            onClick={() => void act(() => api(`/api/admin/strategies/${s.id}/resume`, { method: "POST", body: {} }), "Strategy resumed.")}
          >
            ▶ Resume strategy
          </button>
        </div>
      )}
      <form onSubmit={allocate}>
        <label>
          Allocate simulated paper capital (USDT)
          <input value={amount} onChange={(e) => setAmount(e.target.value.trim())} inputMode="decimal" required />
        </label>
        <span className="muted small">
          Allocated {fmt(s.allocatedCapital)} of max {fmt(s.limits.maxAllocation)}. Paper capital is never customer money.
        </span>
        <button>Allocate</button>
      </form>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
    </div>
  );
}

/**
 * Single-series equity line (simulated) with a crosshair tooltip. Pixel
 * coordinates use JS numbers for layout only; displayed values are the exact
 * decimal strings from the API.
 */
function EquityChart({ series }: { series: StrategyDetail["equitySeries"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const W = 800;
  const H = 220;
  const pad = { l: 8, r: 8, t: 12, b: 20 };
  if (series.length < 2) {
    return (
      <div className="card">
        <h3>Equity (simulated)</h3>
        <p className="muted">Not enough processed ticks yet.</p>
      </div>
    );
  }
  const ys = series.map((p) => Number(p.equity)); // layout only
  let min = Math.min(...ys);
  let max = Math.max(...ys);
  // Labels use the exact decimal strings of the extreme points, not the floats.
  const minLabel = series[ys.indexOf(min)]!.equity;
  const maxLabel = series[ys.indexOf(max)]!.equity;
  if (max === min) {
    max += 1;
    min -= 1;
  }
  const x = (i: number) => pad.l + (i / (series.length - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const path = ys.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const pausedRanges = series.map((p, i) => (p.status === "paused" ? i : -1)).filter((i) => i >= 0);

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const rect = svgRef.current!.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((rel - pad.l) / (W - pad.l - pad.r)) * (series.length - 1));
    setHover(Math.max(0, Math.min(series.length - 1, i)));
  }
  const hp = hover !== null ? series[hover] : null;

  return (
    <div className="card">
      <div className="row spread">
        <h3>Equity, last {series.length} synthetic ticks (simulated)</h3>
        <span className="muted small">
          range {fmt(minLabel)} to {fmt(maxLabel)} USDT
        </span>
      </div>
      <div className="chart-wrap">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="chart"
          role="img"
          aria-label="Simulated equity over synthetic ticks"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          {[0.25, 0.5, 0.75].map((f) => (
            <line key={f} x1={pad.l} x2={W - pad.r} y1={pad.t + f * (H - pad.t - pad.b)} y2={pad.t + f * (H - pad.t - pad.b)} className="grid" />
          ))}
          {pausedRanges.map((i) => (
            <rect key={i} x={x(i) - (W - pad.l - pad.r) / series.length / 2} y={pad.t} width={(W - pad.l - pad.r) / series.length} height={H - pad.t - pad.b} className="paused-band" />
          ))}
          <path d={path} className="line" />
          {hp && hover !== null && (
            <>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="crosshair" />
              <circle cx={x(hover)} cy={y(Number(hp.equity))} r={4} className="dot" />
            </>
          )}
        </svg>
        {hp && hover !== null && (
          <div className="tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <div className="muted small">Tick #{hp.tickSeq} · {hp.status}</div>
            <div>Equity {fmt(hp.equity)}</div>
            <div className="muted small">
              Price {fmt(hp.price, 4)} · DD {pct(hp.drawdownRatio)}
            </div>
          </div>
        )}
      </div>
      <p className="muted small">Shaded bands mark ticks while the strategy was paused.</p>
    </div>
  );
}
