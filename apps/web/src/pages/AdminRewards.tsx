import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  api,
  fmt,
  fmtDate,
  newKey,
  pct,
  type Product,
  type RewardPolicy,
  type RewardPool,
  type RewardRun,
  type RewardRunDetail,
  type StrategySummary,
} from "../api";
import { useLoad } from "../useLoad";
import { SimBadge } from "./AdminStrategies";

export function RunStatus({ status }: { status: RewardRun["status"] }) {
  const icon = { calculated: "◔", posted: "✔", cancelled: "✕", failed: "⚠" }[status];
  return <span className={`run-status ${status}`}>{`${icon} ${status}`}</span>;
}

export function AdminRewardsPage() {
  const pools = useLoad(() => api<{ pools: RewardPool[]; policies: RewardPolicy[] }>("/api/admin/rewards/pools"));
  const runs = useLoad(() => api<{ runs: RewardRun[] }>("/api/admin/rewards/runs"));
  const strategies = useLoad(() => api<{ strategies: StrategySummary[] }>("/api/admin/strategies"));
  const products = useLoad(() => api<{ products: Product[] }>("/api/products"));
  const reload = async () => {
    await Promise.all([pools.reload(), runs.reload(), products.reload()]);
  };
  const poolList = pools.data?.pools ?? [];

  return (
    <div className="stack">
      <div className="row spread">
        <h2>
          Rewards <SimBadge />
        </h2>
        <Link to="/admin">← Admin</Link>
      </div>
      <p className="muted small">
        Customer investments participate in <strong>simulated</strong> strategy pools through allocation records. Their
        principal never moves. Rewards come only from a pool's <strong>realised</strong> simulated profit for a closed
        period, after fees, earlier losses (carry-forward) and the reserve. See <code>docs/rewards-accounting.md</code>.
      </p>
      {(pools.error || runs.error) && <div className="error">{pools.error ?? runs.error}</div>}

      <div className="card">
        <h3>Reward pools</h3>
        {poolList.length === 0 ? (
          <p className="muted">No pools yet. Register a strategy as a pool below.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Pool</th>
                  <th>Status</th>
                  <th className="num">Paper capital</th>
                  <th className="num">Customer capacity</th>
                  <th className="num">Active allocations</th>
                  <th className="num">Reserve</th>
                  <th className="num">Loss carry-forward</th>
                  <th className="num">Distributed</th>
                  <th>Products</th>
                  <th>Last period end</th>
                </tr>
              </thead>
              <tbody>
                {poolList.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/admin/strategies/${p.id}`}>{p.code}</Link>
                      {p.strategyStatus !== "active" && <div className="neg small">strategy {p.strategyStatus}</div>}
                    </td>
                    <td>{p.status}</td>
                    <td className="num">{fmt(p.paperCapital)}</td>
                    <td className="num">{fmt(p.customerCapacity)}</td>
                    <td className="num">
                      {fmt(p.activeAllocations)} <span className="muted small">({p.allocationCount})</span>
                    </td>
                    <td className="num">{fmt(p.reserve, 6)}</td>
                    <td className={`num ${/^0(\.0+)?$/.test(p.lossCarryForward) ? "" : "neg"}`}>{fmt(p.lossCarryForward, 6)}</td>
                    <td className="num">{fmt(p.distributed, 6)}</td>
                    <td>{p.products.map((x) => x.code).join(", ") || <span className="muted">none</span>}</td>
                    <td>{p.lastPeriodEnd ? fmtDate(p.lastPeriodEnd) : <span className="muted">never</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="grid2">
        <CalculateRun pools={poolList} />
        <AssignProduct pools={poolList} products={products.data?.products ?? []} onDone={reload} />
      </div>

      <div className="card">
        <h3>Reward runs (the reward journal)</h3>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Created</th>
                <th>Pool</th>
                <th>Period</th>
                <th>Status</th>
                <th className="num">Net realised</th>
                <th className="num">Eligible</th>
                <th className="num">Rewards</th>
                <th className="num">Reserve</th>
                <th className="num">CF close</th>
                <th>Policy</th>
              </tr>
            </thead>
            <tbody>
              {(runs.data?.runs ?? []).map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/admin/rewards/runs/${r.id}`}>{fmtDate(r.createdAt)}</Link>
                  </td>
                  <td>{r.poolCode}</td>
                  <td className="small">
                    {fmtDate(r.periodStart)} → {fmtDate(r.periodEnd)}
                  </td>
                  <td>
                    <RunStatus status={r.status} />
                  </td>
                  <td className="num">{fmt(r.netRealised, 6)}</td>
                  <td className="num">{fmt(r.eligibleProfit, 6)}</td>
                  <td className="num">{fmt(r.totalRewards, 6)}</td>
                  <td className="num">{fmt(r.reserveContribution, 6)}</td>
                  <td className="num">{fmt(r.cfClose, 6)}</td>
                  <td>v{r.policyVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid2">
        <RegisterPool strategies={(strategies.data?.strategies ?? []).filter((s) => !poolList.some((p) => p.id === s.id))} onDone={reload} />
        <Policies policies={pools.data?.policies ?? []} onDone={reload} />
      </div>
    </div>
  );
}

function CalculateRun({ pools }: { pools: RewardPool[] }) {
  const navigate = useNavigate();
  const [poolId, setPoolId] = useState("");
  const [attempt, setAttempt] = useState(0);
  const idempotencyKey = useMemo(() => newKey(), [poolId, attempt]);
  const [error, setError] = useState<string | null>(null);
  const selected = poolId || pools[0]?.id || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<RewardRunDetail>("/api/admin/rewards/runs", {
        method: "POST",
        body: { poolStrategyId: selected }, // period end = server clock
        idempotencyKey,
      });
      setAttempt((a) => a + 1);
      navigate(`/admin/rewards/runs/${res.run.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Calculate reward run</h3>
      <p className="muted small">
        Closes the period from the pool's last posted run (or registration) to <strong>now</strong>, and calculates it from
        realised trades. Nothing is posted until you review and post the run.
      </p>
      <label>
        Pool
        <select value={selected} onChange={(e) => setPoolId(e.target.value)}>
          {pools.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}
            </option>
          ))}
        </select>
      </label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={!selected}>
        Calculate period ending now
      </button>
    </form>
  );
}

function AssignProduct({ pools, products, onDone }: { pools: RewardPool[]; products: Product[]; onDone: () => Promise<void> }) {
  const [productId, setProductId] = useState("");
  const [poolId, setPoolId] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const product = productId || products[0]?.id || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api("/api/admin/rewards/product-assignments", {
        method: "POST",
        body: { productId: product, poolStrategyId: poolId || null, reason: "admin console" },
      });
      setMsg({ ok: true, text: "Assignment recorded. It applies to new investments only." });
      await onDone();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Assign product to pool</h3>
      <label>
        Product
        <select value={product} onChange={(e) => setProductId(e.target.value)}>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}: {p.pool ? `now ${p.pool.poolCode}` : "no pool"}
            </option>
          ))}
        </select>
      </label>
      <label>
        Pool
        <select value={poolId} onChange={(e) => setPoolId(e.target.value)}>
          <option value="">None (principal only, no rewards)</option>
          {pools
            .filter((p) => p.status === "active")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.code}
              </option>
            ))}
        </select>
      </label>
      <p className="muted small">Each change is recorded in the assignment history and the audit log. Existing allocations do not change.</p>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      <button>Save assignment</button>
    </form>
  );
}

function RegisterPool({ strategies, onDone }: { strategies: StrategySummary[]; onDone: () => Promise<void> }) {
  const [strategyId, setStrategyId] = useState("");
  const [capacity, setCapacity] = useState("25000");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const selected = strategyId || strategies[0]?.id || "";

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await api("/api/admin/rewards/pools", { method: "POST", body: { strategyId: selected, customerCapacity: capacity } });
      setMsg({ ok: true, text: "Pool registered." });
      await onDone();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Register a strategy as a reward pool</h3>
      <label>
        Strategy
        <select value={selected} onChange={(e) => setStrategyId(e.target.value)}>
          {strategies.map((s) => (
            <option key={s.id} value={s.id}>
              {s.code}: paper capital {fmt(s.allocatedCapital)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Customer capacity (USDT)
        <input value={capacity} onChange={(e) => setCapacity(e.target.value.trim())} required />
      </label>
      <p className="muted small">Customer allocations can never exceed this capacity or the pool's paper capital.</p>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      <button disabled={!selected}>Register pool</button>
    </form>
  );
}

function Policies({ policies, onDone }: { policies: RewardPolicy[]; onDone: () => Promise<void> }) {
  const [name, setName] = useState("");
  const [reserveRatio, setReserveRatio] = useState("0.1");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      const res = await api<{ version: number }>("/api/admin/rewards/policies", { method: "POST", body: { name, reserveRatio } });
      setMsg({ ok: true, text: `Policy v${res.version} created; it applies to runs calculated from now on.` });
      setName("");
      await onDone();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h3>Reward policies (versioned, immutable)</h3>
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th>Name</th>
            <th className="num">Reserve</th>
          </tr>
        </thead>
        <tbody>
          {policies.map((p, i) => (
            <tr key={p.id}>
              <td>
                v{p.version} {i === 0 && <span className="muted small">(current)</span>}
              </td>
              <td title={p.description}>{p.name}</td>
              <td className="num">{pct(p.reserveRatio)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid2">
        <label>
          New version name
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        </label>
        <label>
          Reserve ratio
          <input value={reserveRatio} onChange={(e) => setReserveRatio(e.target.value.trim())} required />
        </label>
      </div>
      {msg && <div className={msg.ok ? "success" : "error"}>{msg.text}</div>}
      <button>Create new policy version</button>
    </form>
  );
}
