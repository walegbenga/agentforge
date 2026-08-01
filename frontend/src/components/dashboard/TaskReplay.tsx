import { useEffect, useMemo, useState } from "react";
import type { Task, WSEvent, WSEventType } from "../../types";
import { useDemoTask } from "../../hooks/useApi";
import LiveFeed from "./LiveFeed";

type ReplayEvent = WSEvent & { id: string };

/**
 * Reconstructs a chronological event timeline from a real, already-completed
 * task using data that's already stored: the orchestration log plus each
 * subtask's assigned/submitted/settled timestamps. Nothing here is
 * fabricated — every line is something that actually happened on this task.
 */
function buildReplayEvents(task: Task): ReplayEvent[] {
  const events: ReplayEvent[] = [];
  let i = 0;
  const push = (type: WSEventType, timestamp: string | undefined, payload: unknown) => {
    if (!timestamp) return;
    events.push({ type, taskId: task.id, payload, timestamp, id: `demo-${task.id}-${i++}` });
  };

  push("task:created", task.createdAt, { description: task.description });

  for (const log of task.orchestrationLog || []) {
    push("log:entry", log.timestamp, { message: log.message, level: log.level });
  }

  for (const sub of task.subtasks || []) {
    const agentName = sub.assignedAgent?.name || "Agent";
    push("subtask:assigned", sub.assignedAt, { agentName, capability: sub.capability });
    push("subtask:executing", sub.assignedAt, { agentName });
    push("subtask:submitted", sub.submittedAt, { agentName });
    push("subtask:settled", sub.settledAt, { agentName, payout: sub.budget });
  }

  if (task.completedAt) push("task:updated", task.completedAt, { status: "completed" });

  return events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

export default function TaskReplay() {
  const { task, loading } = useDemoTask();
  const events = useMemo(() => (task ? buildReplayEvents(task) : []), [task]);
  const [visible, setVisible] = useState<ReplayEvent[]>([]);
  const [cursor, setCursor] = useState(0);

  // Reset playback whenever we get a (possibly new) task
  useEffect(() => {
    setVisible([]);
    setCursor(0);
  }, [task?.id]);

  // Step through events on a timer, then pause and loop
  useEffect(() => {
    if (!events.length) return;

    if (cursor >= events.length) {
      const restart = setTimeout(() => {
        setVisible([]);
        setCursor(0);
      }, 4000);
      return () => clearTimeout(restart);
    }

    const delay = cursor === 0 ? 500 : 700;
    const t = setTimeout(() => {
      setVisible((prev) => [events[cursor], ...prev]);
      setCursor((c) => c + 1);
    }, delay);
    return () => clearTimeout(t);
  }, [cursor, events]);

  if (loading) {
    return (
      <div className="card" style={{ padding: 32, textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
        Loading a real task to replay…
      </div>
    );
  }

  // No completed tasks exist yet (e.g. a brand-new deployment) — don't show
  // a broken or empty "demo," just skip it gracefully.
  if (!task || events.length === 0) return null;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <div
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: "var(--arc)",
            boxShadow: "0 0 6px var(--arc)",
            animation: "pulse-glow 2s ease-in-out infinite",
          }}
        />
        <span
          style={{
            fontSize: "0.7rem",
            color: "var(--text-muted)",
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Live replay · real task · real agents · real settlement
        </span>
      </div>
      <p style={{ fontSize: "0.78rem", color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>
        "{task.description}"
      </p>
      <LiveFeed events={visible} />
    </div>
  );
}
