import { useMemo, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmt, fmtDate, newKey, termLabel, type Balance, type Investment, type Product } from "../api";
import { useLoad } from "../useLoad";

export function InvestPage() {
  const navigate = useNavigate();
  const products = useLoad(() => api<{ products: Product[] }>("/api/products"));
  const balances = useLoad(() => api<{ balances: Balance[] }>("/api/balances"));
  const [productId, setProductId] = useState<string>("");
  const [amount, setAmount] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idempotencyKey = useMemo(() => newKey(), [productId, amount]);

  const list = products.data?.products ?? [];
  const product = list.find((p) => p.id === productId) ?? list[0];
  const available = balances.data?.balances.find((b) => b.asset === "USDT")?.available ?? "0";
  const maturityPreview = product ? new Date(Date.now() + product.termMinutes * 60_000).toISOString() : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!product) return;
    setBusy(true);
    setError(null);
    try {
      await api<Investment>("/api/investments", {
        method: "POST",
        body: { productId: product.id, amount },
        idempotencyKey,
      });
      navigate("/investments");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack narrow">
      <h2>New fixed-term investment</h2>
      {products.error && <div className="error">{products.error}</div>}
      <form className="card" onSubmit={submit}>
        <label>
          Product
          <select value={product?.id ?? ""} onChange={(e) => setProductId(e.target.value)}>
            {list.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {termLabel(p.termMinutes)}
                {p.devOnly ? " (dev only)" : ""}
              </option>
            ))}
          </select>
        </label>
        {product && (
          <div className="product-info">
            <p>{product.description}</p>
            <dl>
              <dt>Term</dt>
              <dd>{termLabel(product.termMinutes)}</dd>
              <dt>Minimum</dt>
              <dd>{fmt(product.minAmount)} USDT</dd>
              <dt>Maximum</dt>
              <dd>{product.maxAmount ? `${fmt(product.maxAmount)} USDT` : "No limit"}</dd>
              <dt>Strategy</dt>
              <dd>{product.strategyDescription}</dd>
              <dt>Return</dt>
              <dd>
                {product.pool ? (
                  <>
                    <strong>Variable, not guaranteed.</strong> This product participates in the simulated strategy pool{" "}
                    <strong>{product.pool.poolCode}</strong>. Rewards are paid only from that pool's <em>realised</em> simulated
                    profit after fees, a reserve and any earlier losses, pro rata to your allocation and time invested. Many
                    periods pay nothing. Your principal stays in your account and is returned at maturity. It is not invested
                    anywhere: participation is simulated.
                  </>
                ) : (
                  <>
                    <strong>Principal only.</strong> This product is not linked to a strategy pool, so it earns no rewards.
                  </>
                )}
              </dd>
            </dl>
            <div className="warning small">{product.riskDisclosure}</div>
          </div>
        )}
        <label>
          Amount (USDT) <span className="muted">— available: {fmt(available, 6)}</span>
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.trim())}
            inputMode="decimal"
            pattern="\d+(\.\d{1,6})?"
            placeholder="100.00"
            required
          />
        </label>
        {maturityPreview && (
          <p>
            Estimated maturity date: <strong>{fmtDate(maturityPreview)}</strong>
            <br />
            <span className="muted small">The exact maturity date is fixed by the server when the investment is created.</span>
          </p>
        )}
        <label className="checkbox">
          <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.target.checked)} />I understand
          principal is locked until maturity and that returns are not guaranteed.
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy || !acknowledged || !product}>
          Invest
        </button>
      </form>
    </div>
  );
}
