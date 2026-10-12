import { Navigate, NavLink, Route, Routes } from "react-router-dom";
import { useAuth } from "./auth";
import { AdminPage } from "./pages/Admin";
import { AdminStrategiesPage } from "./pages/AdminStrategies";
import { AdminStrategyPage } from "./pages/AdminStrategy";
import { DashboardPage } from "./pages/Dashboard";
import { InvestPage } from "./pages/Invest";
import { InvestmentsPage } from "./pages/Investments";
import { LoginPage } from "./pages/Login";
import { TransactionsPage } from "./pages/Transactions";

export function App() {
  const { user, loading, logout } = useAuth();
  if (loading) return <div className="center muted">Loading…</div>;
  if (!user) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <div className="shell">
      <div className="sim-banner">SIMULATION — all balances are simulated USDT. No real funds. Returns are not guaranteed.</div>
      <header className="topbar">
        <div className="brand">Connect Income</div>
        <nav>
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/invest">New investment</NavLink>
          <NavLink to="/investments">Investments</NavLink>
          <NavLink to="/transactions">Transactions</NavLink>
          {user.role === "admin" && (
            <NavLink to="/admin" end>
              Admin
            </NavLink>
          )}
          {user.role === "admin" && <NavLink to="/admin/strategies">Strategies (sim)</NavLink>}
        </nav>
        <div className="user">
          <span className="muted">{user.displayName}</span>
          <button className="link" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/invest" element={<InvestPage />} />
          <Route path="/investments" element={<InvestmentsPage />} />
          <Route path="/transactions" element={<TransactionsPage />} />
          {user.role === "admin" && <Route path="/admin" element={<AdminPage />} />}
          {user.role === "admin" && <Route path="/admin/strategies" element={<AdminStrategiesPage />} />}
          {user.role === "admin" && <Route path="/admin/strategies/:id" element={<AdminStrategyPage />} />}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
