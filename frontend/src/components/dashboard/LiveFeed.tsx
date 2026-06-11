import type { WSEvent } from "../../types";

interface Props {
  events: Array<WSEvent & { id: string }>;
}

function getEventDisplay(event: WSEvent): { icon: string; text: string; color: string } {
  switch (event.type) {
    case "task:created":
      return { icon: "⚡", text: "New task created", color: "var(--arc)" };
    case "task:updated": {
      const p = event.payload as any;
      return { icon: "↻", text: `Task → ${p.status}`, color: "var(--yellow)" };
    }
    case "subtask:assigned": {
      const p = event.payload as any;
      return { icon: "→", text: `${p.agentName} hired for ${p.capability}`, color: "var(--arc)" };
    }
    case "subtask:executing": {
      const p = event.payload as any;
      return { icon: "⚙", text: `${p.agentName} executing...`, color: "var(--text-secondary)" };
    }
    case "subtask:submitted": {
      const p = event.payload as any;
      return { icon: "📤", text: `${p.agentName} submitted deliverable`, color: "var(--yellow)" };
    }
    case "subtask:settled": {
      const p = event.payload as any;
      const payout = ((p.payout || 0) / 1_000_000).toFixed(4);
      return { icon: "✓", text: `${p.agentName} paid $${payout} USDC`, color: "var(--green)" };
    }
    case "subtask:disputed": {
      return { icon: "✗", text: "Subtask disputed", color: "var(--red)" };
    }
    case "agent:thinking": {
      const p = event.payload as any;
      return { icon: "💭", text: `${p.agent}: ${p.message}`, color: "var(--text-muted)" };
    }
    case "agent:message": {
      const p = event.payload as any;
      return { icon: "🤖", text: `${p.agent}: ${String(p.message).slice(0, 80)}...`, color: "var(--text-secondary)" };
    }
    case "log:entry": {
      const p = event.payload as any;
      const colors: Record<string, string> = {
        success: "var(--green)",
        warning: "var(--yellow)",
        error: "var(--red)",
        info: "var(--text-secondary)",
      };
      return { icon: "·", text: p.message, color: colors[p.level] || "var(--text-secondary)" };
    }
    default:
      return { icon: "·", text: event.type, color: "var(--text-muted)" };
  }
}

export default function LiveFeed({ events }: Props) {
  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      <div style={{
        padding: "12px 16px",
        borderBottom: "1px solid var(--border)",
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}>
        <div style={{
          width: 6, height: 6, borderRadius: "50%",
          background: "var(--green)",
          boxShadow: "0 0 6px var(--green)",
          animation: "pulse-glow 2s ease-in-out infinite",
        }} />
        <span style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-secondary)", fontFamily: "var(--font-mono)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
          Live Events
        </span>
        <span style={{ marginLeft: "auto", fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
          {events.length}
        </span>
      </div>

      <div className="log-container" style={{ padding: "8px" }}>
        {events.length === 0 ? (
          <div style={{ padding: "32px 16px", textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>
            Waiting for events...
          </div>
        ) : (
          events.map((event) => {
            const { icon, text, color } = getEventDisplay(event);
            return (
              <div
                key={event.id}
                className="animate-slide-in"
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "6px 8px",
                  borderRadius: "var(--radius)",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "var(--bg-hover)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
              >
                <span style={{ color, flexShrink: 0, width: 14, textAlign: "center", fontSize: "0.75rem", marginTop: 1 }}>
                  {icon}
                </span>
                <span style={{ color, fontSize: "0.75rem", lineHeight: 1.5, flex: 1, wordBreak: "break-word" }}>
                  {text}
                </span>
                <span style={{
                  fontSize: "0.65rem",
                  color: "var(--text-muted)",
                  fontFamily: "var(--font-mono)",
                  flexShrink: 0,
                  alignSelf: "flex-start",
                  marginTop: 2,
                }}>
                  {new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
