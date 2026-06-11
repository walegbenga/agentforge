import { ChevronRight } from "lucide-react";
import type { Task, TaskStatus } from "../../types";

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; badge: string }> = {
  pending:     { label: "Pending",     color: "var(--text-muted)",   badge: "badge-muted" },
  decomposing: { label: "Planning",    color: "var(--yellow)",       badge: "badge-yellow" },
  assigning:   { label: "Assigning",   color: "var(--arc)",          badge: "badge-arc" },
  executing:   { label: "Executing",   color: "var(--arc)",          badge: "badge-arc" },
  evaluating:  { label: "Evaluating",  color: "var(--yellow)",       badge: "badge-yellow" },
  completed:   { label: "Completed",   color: "var(--green)",        badge: "badge-green" },
  failed:      { label: "Failed",      color: "var(--red)",          badge: "badge-red" },
  cancelled:   { label: "Cancelled",   color: "var(--text-muted)",   badge: "badge-muted" },
};

interface Props { task: Task; onClick: () => void; }

export default function TaskCard({ task, onClick }: Props) {
  const cfg = STATUS_CONFIG[task.status];
  const budgetUSDC = (task.totalBudget / 1_000_000).toFixed(2);
  const settled = task.subtasks.filter((s) => s.status === "settled").length;
  const total = task.subtasks.length;
  const progress = total > 0 ? (settled / total) * 100 : 0;

  return (
    <div
      className="card animate-fade-in"
      onClick={onClick}
      style={{ cursor: "pointer", padding: "14px 16px" }}
      onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--border-bright)")}
      onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={{
            fontSize: "0.8rem",
            color: "var(--text-primary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            marginBottom: 8,
          }}>
            {task.description}
          </p>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className={`badge ${cfg.badge}`}>
              {["executing", "decomposing", "assigning", "evaluating"].includes(task.status) && (
                <span style={{ display: "inline-block", animation: "spin 1s linear infinite" }}>⟳</span>
              )}
              {cfg.label}
            </span>

            <span className="badge badge-usdc">${budgetUSDC}</span>

            {total > 0 && (
              <span className="badge badge-muted">{settled}/{total} settled</span>
            )}

            <span style={{ fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
              {new Date(task.createdAt).toLocaleTimeString()}
            </span>
          </div>

          {/* Progress bar */}
          {total > 0 && (
            <div style={{ marginTop: 8, height: 2, background: "var(--border)", borderRadius: 1, overflow: "hidden" }}>
              <div style={{
                height: "100%",
                width: `${progress}%`,
                background: task.status === "completed" ? "var(--green)" : "var(--arc)",
                transition: "width 0.5s ease",
                borderRadius: 1,
              }} />
            </div>
          )}
        </div>

        <ChevronRight size={14} color="var(--text-muted)" style={{ flexShrink: 0, marginTop: 2 }} />
      </div>
    </div>
  );
}
