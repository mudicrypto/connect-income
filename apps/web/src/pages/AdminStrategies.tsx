import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, fmt, fmtDate, newKey, pct, signed, type EngineState, type StrategyDetail, type StrategySummary } from "../api";
import { useLoad } from "../useLoad";

export function SimBadge() {
  return <span className="sim-badge">SIMULATED</span>;
}

export function StatusBadge({ status, reason }: { status: string; reason?: string | null }) {
  const auto = status === "paused" && reason?.startsWith("Auto-paused");
  return (
    <span className={`status ${status} ${auto ? "breach" : ""}`} title={reason ?? undefined}>
      {status === "active" ? "● Active" : auto ? "⚠ Paused (risk)" : "❚❚ Paused"}
    </span>
  );
}

export function PnlCell({ value }: { value: string }) {
  const neg = value.startsWith("-");
  const zero = /^-?0(\.0+)?$/.test(value);
  return <span className={zero ? "" : neg ? "neg" : "pos"}>{signed(value)}</span>;
}

export function AdminStrategiesPage() {
  const strategies = useLoad(() => api<{ strategies: StrategySummary[] }>("/api/admin/strategies"));
  const engine = useLoad(() => api<EngineState>("/api/admin/engine"));
  const reloadAll = async () => {
    await Promise.all([strategies.reload(), engine.reload()]);
  };
  const list = strategies.data?.strategies ?? [];

  return (
    <div className="stack">
      <div className="row spread">
        <h2>
          Strategy engine <SimBadge />
        </h2>
        <Link to="/admin">← Admin</Link>
      </div>
      <p className="muted small">
        Paper trading on <strong>synthetic market data</strong> with <strong>simulated paper capital</strong>. Nothing here
        is real trading, real prices or customer money. Strategy results do not change any customer balance.
      </p>
      {(strategies.error || engine.error) && <div className="error">{strategies.error ?? engine.error}</div>}

      <div className="card">
        <h3>Strategies</h3>
        {list.length === 0 ? (
          <p className="muted">No strategies yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Strategy</th>
                  <th>Status</th>
                  <th className="num">Allocated</th>
                  <th className="num">Equity</th>
                  <th className="num">Realised P&amp;L</th>
                  <th className="num">Unrealised P&amp;L</th>
                  <th className="num">Fees</th>
                  <th className="num">Exposure</th>
                  <th className="num">Drawdown</th>
                  <th className="num">Trades</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <Link to={`/admin/strategies/${s.id}`}>{s.code}</Link>
                      <div className="muted small">
                        {s.type} · {s.instrument.symbol}
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={s.status} reason={s.pauseReason} />
                    </td>
                    <td className="num">{fmt(s.allocatedCapital)}</td>
                    <td className="num">{fmt(s.equity)}</td>
                    <td className="num">
                      <PnlCell value={s.realisedPnl} />
                    </td>
                    <td className="num">
                      <PnlCell value={s.unrealisedPnl} />
                    </td>
                    <td className="num">{fmt(s.fees)}</td>
                    <td className="num">{pct(s.exposureRatio)}</td>
                    <td className="num">{pct(s.drawdownRatio)}</td>
                    <td className="num">{s.tradeCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">All values in simulated USDT, marked at each strategy's last processed synthetic tick.</p>
      </div>

      <div className="grid2">
        <EngineControls engine={engine.data} onChange={reloadAll} />
        <KillSwitch engine={engine.data} onChange={reloadAll} />
      </div>

      <CreateStrategy engine={engine.data} />

      {engine.data && (
        <div className="grid2">
          <div className="card">
            <h3>
              Synthetic instruments <SimBadge />
            </h3>
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Kind</th>
                  <th className="num">Last tick</th>
                  <th className="num">Simulated price</th>
                </tr>
              </thead>
              <tbody>
                {engine.data.instruments
                  .filter((i) => i.dataSource === "synthetic_generator")
                  .map((i) => (
                    <tr key={i.id}>
                      <td title={i.name}>{i.symbol}</td>
                      <td>{i.kind}</td>
                      <td className="num">#{i.latestSeq ?? "—"}</td>
                      <td className="num">{i.latestPrice ? fmt(i.latestPrice, 6) : "—"}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="card">
            <h3>Recent engine runs</h3>
            <table>
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th className="num">Ticks</th>
                  <th className="num">Trades</th>
                </tr>
              </thead>
              <tbody>
                {engine.data.runs.slice(0, 8).map((r) => (
                  <tr key={r.id} title={r.error ?? undefined}>
                    <td>{fmtDate(r.startedAt)}</td>
                    <td>{r.trigger}</td>
                    <td className={r.status === "failed" ? "neg" : ""}>{r.status}</td>
                    <td className="num">{r.ticksProcessed}</td>
                    <td className="num">{r.trades}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function EngineControls({ engine, onChange }: { engine: EngineState | null; onChange: () => Promise<void> }) {
  const [ticks, setTicks] = useState("24");
  const [attempt, setAttempt] = useState(0);
  const idempotencyKey = useMemo(() => newKey(), [ticks, attempt]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  async function advanceAndRun(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api("/api/admin/market/advance", { method: "POST", body: { ticks: Number(ticks) }, idempotencyKey });
      setAttempt((a) => a + 1);
      const run = await api<{ status: string; ticksProcessed: number; trades: number; error?: string }>("/api/admin/engine/run", {
        method: "POST",
        body: {},
      });
      setMsg({
        ok: run.status === "completed",
        text: `Generated ${ticks} synthetic tick(s); engine run ${run.status}: ${run.ticksProcessed} tick(s) processed, ${run.trades} simulated trade(s).${run.error ? " " + run.error : ""}`,
      });
      await onChange();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={advanceAndRun}>
      <h3>Simulated market clock</h3>
      <p className="muted small">
        Append synthetic ticks (1 tick = 1 simulated hour) to every instrument, then process all strategies. Processing is
        idempotent: re-running never repeats a tick.
      </p>
      <label>
        Ticks to generate
        <input value={ticks} onChange={(e) => setTicks(e.target.value.replace(/\D/g, ""))} inputMode="numeric" required />
      </label>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      <button className="primary" disabled={busy || !engine || !ticks}>
        Advance synthetic market &amp; run engine
      </button>
    </form>
  );
}

function KillSwitch({ engine, onChange }: { engine: EngineState | null; onChange: () => Promise<void> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const enabled = engine?.killSwitch.enabled ?? false;

  async function toggle() {
    setError(null);
    try {
      await api("/api/admin/engine/kill-switch", { method: "POST", body: { enabled: !enabled, reason } });
      setReason("");
      await onChange();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className={`card ${enabled ? "kill-on" : ""}`}>
      <h3>Global kill switch</h3>
      <p>
        Status: <strong className={enabled ? "neg" : "pos"}>{enabled ? "⛔ ENGAGED: no new positions" : "● Off"}</strong>
        {enabled && engine?.killSwitch.reason && <span className="muted"> ({engine.killSwitch.reason})</span>}
      </p>
      <p className="muted small">When engaged, no strategy can open or increase a position. Exits are still allowed.</p>
      {!enabled && (
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder="e.g. incident review" />
        </label>
      )}
      {error && <div className="error">{error}</div>}
      <button className={enabled ? "" : "danger"} onClick={() => void toggle()} disabled={!engine}>
        {enabled ? "Release kill switch" : "Engage kill switch"}
      </button>
    </div>
  );
}

const DEFAULT_PARAMS: Record<string, object> = {
  trading: { lookbackTicks: 24, entryThresholdBps: 100, exitThresholdBps: -50, targetExposure: "0.5", minTradeValue: "10" },
  staking: { targetExposure: "0.8", rebalanceBand: "0.05", minTradeValue: "10" },
  lending: { targetExposure: "0.9", rebalanceBand: "0.02", minTradeValue: "10" },
};
const KIND_FOR: Record<string, string> = { trading: "spot", staking: "staking", lending: "lending" };

function CreateStrategy({ engine }: { engine: EngineState | null }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    code: "",
    name: "",
    description: "",
    type: "trading",
    instrumentSymbol: "",
    maxAllocation: "100000",
    maxPositionValue: "25000",
    maxExposureRatio: "0.5",
    dailyLossLimit: "2000",
    maxDrawdownRatio: "0.15",
    params: JSON.stringify(DEFAULT_PARAMS.trading, null, 2),
  });
  const [error, setError] = useState<string | null>(null);
  const instruments = (engine?.instruments ?? []).filter((i) => i.kind === KIND_FOR[form.type] && i.dataSource === "synthetic_generator");
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    let params: unknown;
    try {
      params = JSON.parse(form.params);
    } catch {
      setError("Parameters must be valid JSON");
      return;
    }
    try {
      const res = await api<StrategyDetail>("/api/admin/strategies", {
        method: "POST",
        body: { ...form, instrumentSymbol: form.instrumentSymbol || instruments[0]?.symbol, params },
      });
      navigate(`/admin/strategies/${res.strategy.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  if (!open) {
    return (
      <div>
        <button onClick={() => setOpen(true)}>+ Create strategy</button>
      </div>
    );
  }
  return (
    <form className="card" onSubmit={submit}>
      <h3>
        Create strategy <SimBadge />
      </h3>
      <div className="grid3">
        <label>
          Code
          <input value={form.code} onChange={set("code")} placeholder="MY-STRAT" required />
        </label>
        <label>
          Name
          <input value={form.name} onChange={set("name")} required maxLength={80} />
        </label>
        <label>
          Type
          <select
            value={form.type}
            onChange={(e) =>
              setForm((f) => ({ ...f, type: e.target.value, instrumentSymbol: "", params: JSON.stringify(DEFAULT_PARAMS[e.target.value], null, 2) }))
            }
          >
            <option value="trading">Simulated trading</option>
            <option value="staking">Simulated staking</option>
            <option value="lending">Simulated lending</option>
          </select>
        </label>
        <label>
          Synthetic instrument
          <select value={form.instrumentSymbol || instruments[0]?.symbol || ""} onChange={set("instrumentSymbol")}>
            {instruments.map((i) => (
              <option key={i.id} value={i.symbol}>
                {i.symbol}
              </option>
            ))}
          </select>
        </label>
        <label>
          Max allocation (USDT)
          <input value={form.maxAllocation} onChange={set("maxAllocation")} required />
        </label>
        <label>
          Max position value (USDT)
          <input value={form.maxPositionValue} onChange={set("maxPositionValue")} required />
        </label>
        <label>
          Max exposure (ratio of equity)
          <input value={form.maxExposureRatio} onChange={set("maxExposureRatio")} required />
        </label>
        <label>
          Daily loss limit (USDT)
          <input value={form.dailyLossLimit} onChange={set("dailyLossLimit")} required />
        </label>
        <label>
          Max drawdown (ratio)
          <input value={form.maxDrawdownRatio} onChange={set("maxDrawdownRatio")} required />
        </label>
      </div>
      <label>
        Description
        <input value={form.description} onChange={set("description")} maxLength={1000} />
      </label>
      <label>
        Parameters (JSON)
        <textarea rows={6} value={form.params} onChange={set("params")} spellCheck={false} />
      </label>
      <p className="muted small">The server validates every limit and parameter. New strategies start with zero capital.</p>
      {error && <div className="error">{error}</div>}
      <div className="row">
        <button className="primary">Create</button>
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
