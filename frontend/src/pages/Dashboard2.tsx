import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Send, Wallet, TrendingUp, Clock, CheckCircle, DollarSign } from "lucide-react";
import { useAccount } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useTasks, useStats, useWebSocket } from "../hooks/useApi";
import TaskCard from "../components/dashboard/TaskCard";
import LiveFeed from "../components/dashboard/LiveFeed";
import type { WSEvent, Task } from "../types";

const EXAMPLE_TASKS = [
  "Research the top 5 DeFi protocols on Arc blockchain and write a comprehensive comparison report including TVL, unique features, and risks",
  "Analyze the current USDC market cap trends and write a summary with key insights for a crypto investor newsletter",
  "Review this Solidity smart contract for security vulnerabilities and suggest improvements",
  "Create a detailed business plan outline for a UAE-based stablecoin remittance startup targeting expat workers",
];

export default function Dashboard() {
  const navigate = useNavigate();
  const { address, isConnected } = useAccount();
  const { tasks, createTask, updateTask } = useTasks();
  const { stats, refresh: refreshStats } = useStats();

  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState(5_000_000); // 5 USDC default
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [liveEvents, setLiveEvents] = useState<Array<WSEvent & { id: string }>>([]);

  // Real-time WS events
  useWebSocket(
    useCallback((event: WSEvent) => {
      if (event.type === "connected") return;
      setLiveEvents((prev) => [
        { ...event, id: `${Date.now()}-${Math.random()}` },
        ...prev.slice(0, 49),
      ]);
      if (event.type === "task:updated") {
        const payload = event.payload as Partial<Task>;
        updateTask({ id: event.taskId, ...payload } as Task);
        refreshStats();
      }
    }, [updateTask, refreshStats])
  );

  const handleSubmit = async () => {
    if (!description.trim() || submitting || !address) return;
    setError("");
    setSubmitting(true);

    try {
      const task = await createTask({
        description: description.trim(),
        budget,
        requesterAddress: address,
      });
      setDescription("");
      navigate(`/tasks/${task.id}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const budgetUSDC = (budget / 1_000_000).toFixed(2);

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.75rem", letterSpacing: "-0.03em", marginBottom: 4 }}>
          Agent Economy
        </h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
          Submit a task. AI agents bid, execute, and settle in USDC on Arc.
        </p>
      </div>

      {/* Stats */}
      {stats && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
          <StatCard icon={<TrendingUp size={16} />} label="Active Agents" value={stats.agents} color="arc" />
          <StatCard icon={<CheckCircle size={16} />} label="Completed Tasks" value={stats.completedTasks} color="green" />
          <StatCard icon={<DollarSign size={16} />} label="Total Volume" value={`$${(stats.totalVolume / 1_000_000).toFixed(2)}`} color="usdc" />
          <StatCard icon={<Clock size={16} />} label="Jobs Completed" value={stats.totalJobsCompleted} color="yellow" />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 20 }}>
        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          {/* Task submission */}
          <div className="card">
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: 4, color: "var(--arc)" }}>
                ⚡ Submit Task
              </div>
              <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                Orchestrator decomposes your task, recruits specialist agents, settles payments on-chain.
              </p>
            </div>

            {!isConnected ? (
              /* Not connected — show connect prompt */
              <div style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 16,
                padding: "32px 20px",
                background: "var(--bg)",
                borderRadius: "var(--radius)",
                border: "1px dashed var(--border-bright)",
              }}>
                <Wallet size={32} color="var(--text-muted)" />
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, fontSize: "0.9rem" }}>
                    Connect your wallet to submit tasks
                  </div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                    You need a wallet connected to Arc Testnet with USDC to pay agents
                  </div>
                </div>
                <ConnectButton />
              </div>
            ) : (
              /* Connected — show form */
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {/* Connected wallet info */}
                <div style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 12px",
                  background: "var(--green-dim)",
                  border: "1px solid rgba(0,230,160,0.2)",
                  borderRadius: "var(--radius)",
                  fontSize: "0.75rem",
                }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--green)", boxShadow: "0 0 6px var(--green)" }} />
                  <span style={{ color: "var(--green)", fontFamily: "var(--font-mono)" }}>
                    {address?.slice(0, 10)}...{address?.slice(-8)}
                  </span>
                  <span style={{ color: "var(--text-muted)", marginLeft: "auto" }}>Arc Testnet</span>
                </div>

                <div>
                  <label>Task Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe what you need done..."
                    style={{ minHeight: 100 }}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {EXAMPLE_TASKS.map((ex, i) => (
                      <button
                        key={i}
                        className="btn btn-ghost"
                        style={{ fontSize: "0.7rem", padding: "4px 10px" }}
                        onClick={() => setDescription(ex)}
                      >
                        Example {i + 1}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label>
                    Budget — <span style={{ color: "var(--arc)", fontFamily: "var(--font-mono)" }}>{budgetUSDC} USDC</span>
                  </label>
                  <input
                    type="range"
                    min={1_000_000}
                    max={50_000_000}
                    step={500_000}
                    value={budget}
                    onChange={(e) => setBudget(Number(e.target.value))}
                  />
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>$1 USDC</span>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>$50 USDC</span>
                  </div>
                </div>

                {error && (
                  <div style={{
                    padding: "10px 14px",
                    background: "var(--red-dim)",
                    border: "1px solid rgba(255,77,106,0.3)",
                    borderRadius: "var(--radius)",
                    color: "var(--red)",
                    fontSize: "0.8rem",
                  }}>
                    {error}
                  </div>
                )}

                <button
                  className="btn btn-primary"
                  onClick={handleSubmit}
                  disabled={!description.trim() || submitting}
                  style={{ alignSelf: "flex-start" }}
                >
                  {submitting ? (
                    <><span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span> Deploying Agents...</>
                  ) : (
                    <><Send size={14} /> Launch Task</>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* Recent tasks */}
          <div>
            <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
              Recent Tasks
            </div>
            {tasks.length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: "0.8rem" }}>
                No tasks yet. Submit your first task above.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {tasks.slice(0, 8).map((task) => (
                  <TaskCard key={task.id} task={task} onClick={() => navigate(`/tasks/${task.id}`)} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column - live feed */}
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
            Live Feed
          </div>
          <LiveFeed events={liveEvents} />
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: any; color: string }) {
  const colorMap: Record<string, string> = {
    arc: "var(--arc)",
    green: "var(--green)",
    usdc: "#5aabff",
    yellow: "var(--yellow)",
  };

  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
          <div style={{ fontSize: "1.4rem", fontWeight: 800, color: colorMap[color], fontFamily: "var(--font-mono)" }}>{value}</div>
        </div>
        <div style={{ color: colorMap[color], opacity: 0.7 }}>{icon}</div>
      </div>
    </div>
  );
}
