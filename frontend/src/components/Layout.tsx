import { Outlet, NavLink } from "react-router-dom";
import { LayoutDashboard, Bot, Zap, Wallet } from "lucide-react"; // ✅ Added Wallet icon
import { useMyStats } from "../hooks/useApi"; // ✅ Changed to useMyStats
import { useAccount } from "wagmi"; // ✅ Added useAccount
import WalletButton from "./wallet/WalletButton";
import { useState, useEffect } from "react";

export default function Layout() {
  const { isConnected } = useAccount(); // ✅ Check if wallet is connected
  const { stats: myStats } = useMyStats(); // ✅ Get user-specific stats
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    const wsUrl = import.meta.env.VITE_WS_URL || "ws://localhost:3001/ws";
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => setWsConnected(true);
    ws.onclose = () => setWsConnected(false);
    return () => ws.close();
  }, []);

  return (
    <div style={{ display: "flex", minHeight: "100vh", position: "relative", zIndex: 1 }}>
      {/* Sidebar */}
      <aside style={{
        width: 220,
        background: "var(--bg-panel)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        position: "fixed",
        top: 0, left: 0, bottom: 0,
        zIndex: 50,
      }}>
        {/* Logo */}
        <div style={{ padding: "24px 20px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 32, height: 32,
              background: "var(--arc)",
              borderRadius: 8,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "var(--arc-glow)",
            }}>
              <Zap size={18} color="#000" fill="#000" />
            </div>
            <div>
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1rem", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
                AgentForge
              </div>
              <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Arc Testnet
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ padding: "16px 12px", flex: 1 }}>
          <NavItem to="/" icon={<LayoutDashboard size={16} />} label="Dashboard" />
          <NavItem to="/agents" icon={<Bot size={16} />} label="Agents" />
        </nav>

        {/* Stats footer */}
        <div style={{ padding: "16px", borderTop: "1px solid var(--border)" }}>
          
          {/* ✅ Show personal stats if connected, otherwise show connect prompt */}
          {isConnected && myStats ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              <StatRow label="My Agents" value={myStats.agents} />
              <StatRow label="My Tasks" value={myStats.completedTasks} />
              <StatRow label="My Volume" value={`$${(myStats.totalVolume / 1_000_000).toFixed(2)}`} />
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, color: "var(--text-muted)", fontSize: "0.7rem", fontFamily: "var(--font-mono)" }}>
              <Wallet size={12} />
              <span>Connect to see stats</span>
            </div>
          )}

          {/* WebSocket Status */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{
              width: 6, height: 6, borderRadius: "50%",
              background: wsConnected ? "var(--green)" : "var(--red)",
              boxShadow: wsConnected ? "0 0 6px var(--green)" : "none",
            }} />
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {wsConnected ? "Live" : "Offline"}
            </span>
          </div>
        </div>
      </aside>

      {/* Main content */}
      <div style={{ marginLeft: 220, flex: 1, display: "flex", flexDirection: "column", minHeight: "100vh" }}>
        {/* Top header with wallet */}
        <header style={{
          height: 60,
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          padding: "0 32px",
          background: "var(--bg-panel)",
          position: "sticky",
          top: 0,
          zIndex: 40,
        }}>
          <WalletButton />
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: "32px" }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function NavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      style={({ isActive }) => ({
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 12px",
        borderRadius: "var(--radius)",
        marginBottom: 2,
        color: isActive ? "var(--arc)" : "var(--text-secondary)",
        background: isActive ? "var(--arc-dim)" : "transparent",
        fontWeight: isActive ? 600 : 400,
        fontSize: "0.875rem",
        textDecoration: "none",
        transition: "all 0.15s",
        border: isActive ? "1px solid rgba(0,212,255,0.15)" : "1px solid transparent",
      })}
    >
      {icon}
      {label}
    </NavLink>
  );
}

function StatRow({ label, value }: { label: string; value: any }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
      <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{label}</span>
      <span style={{ fontSize: "0.75rem", color: "var(--text-secondary)", fontFamily: "var(--font-mono)", fontWeight: 700 }}>{value}</span>
    </div>
  );
}