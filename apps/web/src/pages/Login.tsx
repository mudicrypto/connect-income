import { useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";

export function LoginPage() {
  const { refresh, devMode } = useAuth();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(() =>
      mode === "login"
        ? api("/api/auth/login", { method: "POST", body: { email, password } })
        : api("/api/auth/register", { method: "POST", body: { email, password, displayName } }),
    );
  }

  return (
    <div className="auth-page">
      <div className="card auth-card">
        <h1>Connect Income</h1>
        <p className="muted">Crypto-finance simulator. All funds are simulated; nothing here is real money.</p>
        <div className="tabs">
          <button className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>
            Log in
          </button>
          <button className={mode === "register" ? "active" : ""} onClick={() => setMode("register")}>
            Register
          </button>
        </div>
        <form onSubmit={submit}>
          {mode === "register" && (
            <label>
              Display name
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} />
            </label>
          )}
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </label>
          <label>
            Password {mode === "register" && <span className="muted">(min 10 characters)</span>}
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === "register" ? 10 : 1}
              autoComplete={mode === "login" ? "current-password" : "new-password"}
            />
          </label>
          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={busy}>
            {mode === "login" ? "Log in" : "Create account"}
          </button>
        </form>
        {devMode && (
          <div className="dev-login">
            <div className="muted small">Development mode</div>
            <button disabled={busy} onClick={() => void run(() => api("/api/auth/dev-login", { method: "POST", body: {} }))}>
              One-click login as Demo User
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
