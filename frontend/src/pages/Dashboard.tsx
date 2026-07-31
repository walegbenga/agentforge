import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAccount } from "wagmi";
import { Plus, ChevronRight, Clock, CheckCircle, XCircle, Zap, Wallet, AlertCircle, FileClock } from "lucide-react";
import { useTasks, useWebSocket } from "../hooks/useApi";
import type { WSEvent } from "../types";
import { useCallback } from "react";

export default function Dashboard() {
  const { address, isConnected } = useAccount();
  const { tasks, createTask, refresh } = useTasks(address);
  //const createTask = useCreateTask();
  const navigate = useNavigate();

  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useWebSocket(
    useCallback(
      (event: WSEvent) => {
        if (!address) return;
        if (event.type === "task:created" || event.type === "task:updated") {
          refresh();
        }
      },
      [address, refresh]
    )
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected || !address) {
      setError("Connect your wallet to submit a task");
      return;
    }
    if (!description.trim()) {
      setError("Please describe your task");
      return;
    }
    if (budget < 1) {
      setError("Minimum budget is 1 USDC");
      return;
    }

    setSubmitting(true);
    setError("");

    try {
      const result = await createTask({
        description: description.trim(),
        budget: Math.floor(budget * 1_000_000),
      });
      navigate(`/tasks/${result.id}`);
    } catch (err: any) {
      setError(err.message || "Failed to create task");
    } finally {
      setSubmitting(false);
    }
  };

  const recentTasks = tasks.slice(0, 8);

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto" }}>
      {/* Hero */}
      <div style={{ marginBottom: 32 }}>
        <h1
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 800,
            fontSize: "1.8rem",
            letterSpacing: "-0.03em",
            marginBottom: 6,
          }}
        >
          {/* ✅ REBRANDED */}
          Welcome to ForgeOps AI
        </h1>
        {/* ✅ REBRANDED */}
        <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem" }}>
          Multi-agent automation platform. Submit a task, let specialized AI agents collaborate, and get real results.
        </p>
      </div>

      {/* Stats */}
      <div className="stats-grid" style={{ marginBottom: 32 }}>
        <StatCard
          label="Total Tasks"
          value={tasks.length}
          icon={<Clock size={16} />}
          color="var(--arc)"
        />
        <StatCard
          label="Completed"
          value={tasks.filter((t) => t.status === "completed").length}
          icon={<CheckCircle size={16} />}
          color="var(--green)"
        />
        <StatCard
          label="In Progress"
          value={tasks.filter((t) => !["completed", "failed", "cancelled"].includes(t.status)).length}
          icon={<Zap size={16} />}
          color="var(--yellow)"
        />
        <StatCard
          label="Total Volume"
          value={`$${(tasks.reduce((s, t) => s + t.totalBudget, 0) / 1_000_000).toFixed(2)}`}
          icon={<Wallet size={16} />}
          color="var(--usdc)"
        />
      </div>

      <div className="dashboard-grid">
        {/* Recent Tasks */}
        <div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 14,
            }}
          >
            <h2
              style={{
                fontWeight: 700,
                fontSize: "0.95rem",
                color: "var(--text-primary)",
              }}
            >
              Recent Tasks
            </h2>
            {tasks.length > 8 && (
              <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                Showing 8 of {tasks.length}
              </span>
            )}
          </div>

          {recentTasks.length === 0 ? (
            <div
              className="card"
              style={{
                textAlign: "center",
                padding: 48,
                color: "var(--text-muted)",
                fontSize: "0.85rem",
              }}
            >
              <FileClock size={32} color="var(--text-muted)" style={{ opacity: 0.6, marginBottom: 12 }} />
              <div>No tasks yet. Submit your first task to get started.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {recentTasks.map((task) => (
                <TaskRow key={task.id} task={task} onClick={() => navigate(`/tasks/${task.id}`)} />
              ))}
            </div>
          )}
        </div>

        {/* Create Task Form */}
        <div>
          <div
            style={{
              fontWeight: 700,
              fontSize: "0.95rem",
              color: "var(--text-primary)",
              marginBottom: 14,
            }}
          >
            Submit New Task
          </div>
          <div className="card" style={{ padding: 20 }}>
            {!isConnected ? (
              // Wallet-gate up front: explain what's needed before the user
              // invests effort filling out a form they can't submit.
              <div style={{ textAlign: "center", padding: "24px 8px" }}>
                <Wallet size={28} color="var(--text-muted)" style={{ opacity: 0.6, marginBottom: 10 }} />
                <div style={{ fontSize: "0.85rem", color: "var(--text-secondary)", marginBottom: 4 }}>
                  Connect your wallet to submit a task
                </div>
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)" }}>
                  Task budgets are locked in USDC escrow on Arc testnet.
                </div>
              </div>
            ) : (
              <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: 16 }}>
                  <label htmlFor="task-description">Task Description</label>
                  <textarea
                    id="task-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="e.g., Analyze the top 10 DeFi protocols and write a 500-word research report..."
                    disabled={submitting}
                    style={{ fontSize: "0.85rem" }}
                  />
                </div>

                <div style={{ marginBottom: 16 }}>
                  <label htmlFor="task-budget">Budget (USDC)</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <input
                      id="task-budget"
                      type="range"
                      min="1"
                      max="50"
                      step="1"
                      value={budget}
                      onChange={(e) => setBudget(Number(e.target.value))}
                      disabled={submitting}
                      style={{ flex: 1 }}
                    />
                    <span
                      className="badge badge-usdc"
                      style={{ fontSize: "0.85rem", padding: "6px 12px", minWidth: 70, textAlign: "center" }}
                    >
                      ${budget}
                    </span>
                  </div>
                  <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginTop: 6, fontFamily: "var(--font-mono)" }}>
                    Funds locked in escrow • Settled on Arc testnet
                  </div>
                </div>

                {error && (
                  <div
                    role="alert"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      padding: "8px 12px",
                      background: "var(--red-dim)",
                      border: "1px solid rgba(255,77,106,0.2)",
                      borderRadius: "var(--radius)",
                      color: "var(--red)",
                      fontSize: "0.78rem",
                      marginBottom: 12,
                    }}
                  >
                    <AlertCircle size={14} />
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  className="btn btn-primary btn-full-mobile"
                  disabled={submitting}
                  style={{ width: "100%", justifyContent: "center" }}
                >
                  {submitting ? (
                    <>
                      <span className="animate-spin">⟳</span> Submitting...
                    </>
                  ) : (
                    <>
                      <Plus size={16} /> Submit Task
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: any; icon: React.ReactNode; color: string }) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 6,
            background: `${color}20`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color,
          }}
        >
          {icon}
        </div>
        <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          {label}
        </span>
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "1.4rem", color }}>{value}</div>
    </div>
  );
}

function TaskRow({ task, onClick }: { task: any; onClick: () => void }) {
  const statusConfig: Record<string, { badge: string; icon: React.ReactNode; label: string }> = {
    pending: { badge: "badge-muted", icon: <Clock size={10} />, label: "Pending" },
    decomposing: { badge: "badge-yellow", icon: <Zap size={10} />, label: "Decomposing" },
    assigning: { badge: "badge-arc", icon: <Zap size={10} />, label: "Assigning" },
    executing: { badge: "badge-arc", icon: <Zap size={10} />, label: "Executing" },
    evaluating: { badge: "badge-yellow", icon: <Clock size={10} />, label: "Evaluating" },
    completed: { badge: "badge-green", icon: <CheckCircle size={10} />, label: "Completed" },
    failed: { badge: "badge-red", icon: <XCircle size={10} />, label: "Failed" },
    cancelled: { badge: "badge-muted", icon: <XCircle size={10} />, label: "Cancelled" },
  };

  const cfg = statusConfig[task.status] || statusConfig.pending;
  const isActive = ["decomposing", "assigning", "executing", "evaluating"].includes(task.status);

  return (
    <div
      className="card animate-fade-in"
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      aria-label={`View task: ${task.description}`}
      style={{
        padding: "12px 16px",
        cursor: "pointer",
        borderColor: isActive ? "var(--arc)" : "var(--border)",
        transition: "all 0.15s",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
            <span className={`badge ${cfg.badge}`}>
              {isActive && <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>}
              {cfg.icon}
              {cfg.label}
            </span>
            <span className="badge badge-usdc" style={{ fontSize: "0.65rem" }}>
              ${(task.totalBudget / 1_000_000).toFixed(2)}
            </span>
          </div>
          <p
            style={{
              fontSize: "0.8rem",
              color: "var(--text-secondary)",
              lineHeight: 1.4,
              overflow: "hidden",
              textOverflow: "ellipsis",
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
            }}
          >
            {task.description}
          </p>
        </div>
        <ChevronRight size={16} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: 4 }} aria-hidden="true" />
      </div>
    </div>
  );
}