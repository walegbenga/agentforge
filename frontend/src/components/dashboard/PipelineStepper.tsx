import { Check, Loader2, X, Circle } from "lucide-react";
import type { Task, SubtaskStatus } from "../../types";

type StepState = "done" | "active" | "pending" | "failed";

function subtaskToStepState(status?: SubtaskStatus): StepState {
  if (!status) return "pending";
  if (status === "settled") return "done";
  if (status === "disputed") return "failed";
  if (["pending"].includes(status)) return "pending";
  return "active"; // assigned, executing, submitted, evaluating
}

const STATE_STYLE: Record<StepState, { color: string; bg: string; icon: React.ReactNode }> = {
  done:    { color: "var(--green)",  bg: "var(--green-dim)",  icon: <Check size={13} /> },
  active:  { color: "var(--arc)",    bg: "var(--arc-dim)",    icon: <Loader2 size={13} className="animate-spin" /> },
  failed:  { color: "var(--red)",    bg: "var(--red-dim)",    icon: <X size={13} /> },
  pending: { color: "var(--text-muted)", bg: "var(--bg-hover)", icon: <Circle size={10} /> },
};

/**
 * Only renders for tasks that actually follow the build pipeline (have a
 * planning and/or app-builder subtask) — showing this for a plain research
 * task would misrepresent what happened. Every state shown here is derived
 * from real subtask data, not decorative.
 */
export default function PipelineStepper({ task }: { task: Task }) {
  const planning = task.subtasks.find((s) => s.capability === "planning");
  const builder = task.subtasks.filter((s) => s.capability === "app-builder");
  const review = task.subtasks.find((s) => s.capability === "code-review");

  const hasBuildPipeline = builder.length > 0;
  if (!hasBuildPipeline) return null;

  // If app-builder was retried, the "furthest" attempt represents current
  // progress for this stage — a disputed original with a settled retry
  // should read as done, not failed.
  const builderState: StepState = builder.some((s) => s.status === "settled")
    ? "done"
    : builder.some((s) => ["executing", "assigned", "submitted", "evaluating"].includes(s.status))
      ? "active"
      : builder.every((s) => s.status === "disputed")
        ? "failed"
        : "pending";

  const steps: { label: string; sub: string; state: StepState }[] = [
    { label: "Idea", sub: "Submitted", state: "done" },
    { label: "Spec", sub: "Planning", state: subtaskToStepState(planning?.status) },
    { label: "Code", sub: "App-Builder", state: builderState },
    { label: "Review", sub: "Code-Review", state: subtaskToStepState(review?.status) },
    {
      label: "Output",
      sub: task.status === "completed" ? "Delivered" : "Pending",
      state: task.status === "completed" ? "done" : "pending",
    },
  ];

  return (
    <div className="card" style={{ marginBottom: 20, padding: "16px 20px" }}>
      <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 14 }}>
        Build Pipeline
      </div>
      <div style={{ display: "flex", alignItems: "center" }}>
        {steps.map((step, i) => {
          const style = STATE_STYLE[step.state];
          return (
            <div key={step.label} style={{ display: "flex", alignItems: "center", flex: i < steps.length - 1 ? 1 : "none" }}>
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, minWidth: 64 }}>
                <div
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "50%",
                    background: style.bg,
                    color: style.color,
                    border: `1.5px solid ${style.color}`,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {style.icon}
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-primary)" }}>{step.label}</div>
                  <div style={{ fontSize: "0.62rem", color: "var(--text-muted)" }}>{step.sub}</div>
                </div>
              </div>
              {i < steps.length - 1 && (
                <div
                  style={{
                    flex: 1,
                    height: 2,
                    background: step.state === "done" ? "var(--green)" : "var(--border)",
                    margin: "0 4px 22px",
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
