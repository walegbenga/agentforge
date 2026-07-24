import { useAccount } from "wagmi";
import { useAgents } from "../hooks/useApi";
import type { AgentProfile } from "../types";
import { Bot, Star, Briefcase, DollarSign, Wallet } from "lucide-react";

const CAPABILITY_COLORS: Record<string, string> = {
  research:         "badge-arc",
  "data-analysis":  "badge-yellow",
  "code-review":    "badge-green",
  "content-writing":"badge-muted",
  summarization:    "badge-muted",
  translation:      "badge-muted",
  "fact-checking":  "badge-arc",
  "math-reasoning": "badge-yellow",
  "image-analysis": "badge-muted",
  planning:         "badge-green",
};

export default function Agents() {
  const { isConnected } = useAccount(); // ✅ Added
  const { agents, loading } = useAgents();

  // ✅ STRICT GUARD: Hide everything if not connected
  if (!isConnected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: 400, gap: 16 }}>
        <Wallet size={48} color="var(--text-muted)" style={{ opacity: 0.5 }} />
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.9rem", textAlign: "center" }}>
          Connect your wallet to view your agent profile
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 300 }}>
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.8rem" }}>
          Loading agents...
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.75rem", letterSpacing: "-0.03em", marginBottom: 4 }}>
          Agent Directory
        </h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
          {agents.length} specialist agents registered on Arc. Reputation built on-chain through settled jobs.
        </p>
      </div>

      {/* Leaderboard header */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "32px 1fr 100px 90px 120px 100px",
        gap: 12,
        padding: "8px 16px",
        fontSize: "0.65rem",
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.08em",
        fontWeight: 600,
        borderBottom: "1px solid var(--border)",
        marginBottom: 8,
      }}>
        <span>#</span>
        <span>Agent</span>
        <span>Reputation</span>
        <span>Jobs</span>
        <span>Earned</span>
        <span>Price/Task</span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {agents
          .sort((a, b) => b.reputationScore - a.reputationScore)
          .map((agent, i) => (
            <AgentRow key={agent.id} agent={agent} rank={i + 1} />
          ))}
      </div>
    </div>
  );
}

function AgentRow({ agent, rank }: { agent: AgentProfile; rank: number }) {
  const isTop = rank <= 3;

  return (
    <div
      className="card animate-fade-in"
      style={{
        padding: "14px 16px",
        display: "grid",
        gridTemplateColumns: "32px 1fr 100px 90px 120px 100px",
        gap: 12,
        alignItems: "center",
        borderColor: rank === 1 ? "rgba(0,212,255,0.25)" : "var(--border)",
      }}
    >
      {/* Rank */}
      <span style={{
        fontFamily: "var(--font-mono)",
        fontWeight: 700,
        fontSize: "0.8rem",
        color: rank === 1 ? "var(--arc)" : rank === 2 ? "var(--text-secondary)" : "var(--text-muted)",
      }}>
        {rank === 1 ? "★" : rank}
      </span>

      {/* Identity */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{
          width: 32, height: 32,
          borderRadius: "50%",
          background: agent.active ? "var(--arc-dim)" : "var(--bg-hover)",
          border: `1px solid ${agent.active ? "rgba(0,212,255,0.3)" : "var(--border)"}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: "1rem",
          flexShrink: 0,
          ...(agent.active ? { animation: "pulse-glow 3s ease-in-out infinite" } : {}),
        }}>
          🤖
        </div>
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", marginBottom: 2 }}>{agent.name}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
            {agent.capabilities.map((cap) => (
              <span key={cap} className={`badge ${CAPABILITY_COLORS[cap] || "badge-muted"}`} style={{ fontSize: "0.6rem", padding: "1px 6px" }}>
                {cap}
              </span>
            ))}
          </div>
          <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", marginTop: 3 }}>
            {agent.walletAddress.slice(0, 10)}...{agent.walletAddress.slice(-8)}
          </div>
        </div>
      </div>

      {/* Reputation */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
          <Star size={10} color="var(--yellow)" fill="var(--yellow)" />
          <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "0.85rem", color: "var(--yellow)" }}>
            {agent.reputationScore.toFixed(1)}
          </span>
        </div>
        <div style={{ height: 3, background: "var(--border)", borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%",
            width: `${agent.reputationScore}%`,
            background: agent.reputationScore >= 80 ? "var(--green)" : agent.reputationScore >= 60 ? "var(--yellow)" : "var(--red)",
            borderRadius: 2,
            transition: "width 1s ease",
          }} />
        </div>
      </div>

      {/* Jobs */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <Briefcase size={12} color="var(--text-muted)" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
          {agent.jobsCompleted}
        </span>
      </div>

      {/* Earned */}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <DollarSign size={12} color="var(--green)" />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.85rem", color: "var(--green)" }}>
          {(agent.totalEarned / 1_000_000).toFixed(4)} USDC
        </span>
      </div>

      {/* Price */}
      <span className="badge badge-usdc">
        ${(agent.pricePerTask / 1_000_000).toFixed(4)}
      </span>
    </div>
  );
}