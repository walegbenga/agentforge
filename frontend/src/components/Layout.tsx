import { Outlet, NavLink } from "react-router-dom";
import { LayoutDashboard, Bot, Wallet } from "lucide-react";
import { useMyStats } from "../hooks/usemystats";
import { useAccount } from "wagmi";
import WalletButton from "./wallet/WalletButton";
import { useState, useEffect } from "react";

export default function Layout() {
  const { isConnected } = useAccount();
  const { stats: myStats } = useMyStats();
  const [wsConnected, setWsConnected] = useState(false);

  useEffect(() => {
    const wsUrl = import.meta.env.VITE_WS_URL || "ws://localhost:3001/ws";
    let reconnect: ReturnType<typeof setTimeout>;
    function connect() {
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => setWsConnected(true);
      ws.onclose = () => { setWsConnected(false); reconnect = setTimeout(connect, 3000); };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => clearTimeout(reconnect);
  }, []);

  return (
    <div style={{ display: "flex", minHeight: "100vh", position: "relative", zIndex: 1 }}>
      {/* Desktop Sidebar */}
      <aside className="layout-sidebar">
        <div style={{ padding: "24px 20px 20px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <img
              src="/icon-192.png"
              alt="ForgeOps AI"
              width={32}
              height={32}
              style={{ display: "block", flexShrink: 0 }}
            />
            <div>
              {/* ✅ REBRANDED */}
              <div style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1rem", color: "var(--text-primary)", letterSpacing: "-0.02em" }}>
                ForgeOps AI
              </div>
              {/* ✅ REBRANDED */}
              <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.1em" }}>
                Multi-Agent Automation
              </div>
            </div>
          </div>
        </div>
        <nav style={{ padding: "16px 12px", flex: 1 }}>
          <SidebarNavItem to="/" icon={<LayoutDashboard size={16} />} label="Dashboard" />
          <SidebarNavItem to="/agents" icon={<Bot size={16} />} label="Agents" />
        </nav>
        <div style={{ padding: "16px", borderTop: "1px solid var(--border)" }}>
          {isConnected && myStats ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
              <StatRow label="My Tasks" value={myStats.completedTasks} />
              <StatRow label="My Volume" value={`$${(myStats.totalVolume / 1_000_000).toFixed(2)}`} />
            </div>
          ) : (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, color: "var(--text-muted)", fontSize: "0.7rem", fontFamily: "var(--font-mono)" }}>
              <Wallet size={12} />
              <span>Connect to see stats</span>
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: wsConnected ? "var(--green)" : "var(--red)", boxShadow: wsConnected ? "0 0 6px var(--green)" : "none" }} />
            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {wsConnected ? "Live" : "Offline"}
            </span>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="layout-main">
        <header className="layout-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <img
              src="/icon-192.png"
              alt="ForgeOps AI"
              width={28}
              height={28}
              style={{ display: "block", flexShrink: 0, borderRadius: 6 }}
            />
            <span style={{ fontWeight: 800, fontSize: "0.9rem", color: "var(--text-primary)" }}>ForgeOps AI</span>
          </div>
          <WalletButton />
        </header>
        <main className="layout-content">
          <Outlet />
        </main>
      </div>

      {/* Mobile Bottom Nav */}
      <nav className="bottom-nav">
        <BottomNavItem to="/" icon={<LayoutDashboard size={20} />} label="Dashboard" />
        <BottomNavItem to="/agents" icon={<Bot size={20} />} label="Agents" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 3, flex: 1 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: wsConnected ? "var(--green)" : "var(--red)", boxShadow: wsConnected ? "0 0 6px var(--green)" : "none" }} />
          <span style={{ fontSize: "0.6rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
            {wsConnected ? "Live" : "Off"}
          </span>
        </div>
      </nav>
    </div>
  );
}

function SidebarNavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink to={to} end={to === "/"}
      style={({ isActive }) => ({
        display: "flex", alignItems: "center", gap: 10,
        padding: "9px 12px", borderRadius: "var(--radius)", marginBottom: 2,
        color: isActive ? "var(--arc)" : "var(--text-secondary)",
        background: isActive ? "var(--arc-dim)" : "transparent",
        fontWeight: isActive ? 600 : 400, fontSize: "0.875rem",
        textDecoration: "none", transition: "all 0.15s",
        border: isActive ? "1px solid rgba(0,212,255,0.15)" : "1px solid transparent",
      })}
    >
      {icon}{label}
    </NavLink>
  );
}

function BottomNavItem({ to, icon, label }: { to: string; icon: React.ReactNode; label: string }) {
  return (
    <NavLink to={to} end={to === "/"}
      className={({ isActive }) => `bottom-nav-item${isActive ? " active" : ""}`}
    >
      {icon}
      <span>{label}</span>
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