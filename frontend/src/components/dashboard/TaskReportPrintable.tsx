import ReactMarkdown from "react-markdown";
import type { Task, Subtask, SubtaskStatus } from "../../types";
import { parseFileDeliverable } from "../../utils/fileDeliverable";

const STATUS_STYLE: Record<SubtaskStatus, { label: string; color: string; bg: string }> = {
  settled: { label: "SETTLED", color: "#0a7a4a", bg: "#e6f7ef" },
  disputed: { label: "DISPUTED", color: "#a3231a", bg: "#fceceb" },
  submitted: { label: "SUBMITTED", color: "#8a6300", bg: "#fdf3d9" },
  evaluating: { label: "EVALUATING", color: "#8a6300", bg: "#fdf3d9" },
  executing: { label: "EXECUTING", color: "#1d4ed8", bg: "#e8effd" },
  assigned: { label: "ASSIGNED", color: "#1d4ed8", bg: "#e8effd" },
  pending: { label: "PENDING — unclaimed", color: "#57606f", bg: "#eceff2" },
};

function formatUSDC(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

// Renders deliverable markdown with real, print-friendly code blocks:
// monospace, wrapped (so long lines don't run off the page edge), light
// gray background so it reads as "code" without needing color printing.
function DeliverableBody({ markdown }: { markdown: string }) {
  return (
    <ReactMarkdown
      components={{
        code({ className, children }) {
          const isBlock = /language-/.test(className || "") || String(children).includes("\n");
          if (isBlock) {
            return (
              <pre
                style={{
                  background: "#f4f5f7",
                  border: "1px solid #dde1e7",
                  borderRadius: 4,
                  padding: "10px 12px",
                  fontFamily: "'Courier New', Courier, monospace",
                  fontSize: "13.1px",
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  color: "#1a1a1a",
                  margin: "8px 0",
                }}
              >
                {String(children).replace(/\n$/, "")}
              </pre>
            );
          }
          return (
            <code
              style={{
                fontFamily: "'Courier New', Courier, monospace",
                background: "#f4f5f7",
                padding: "1px 4px",
                borderRadius: 3,
                fontSize: "0.92em",
              }}
            >
              {children}
            </code>
          );
        },
        h1: ({ children }) => <h3 style={{ fontSize: 17.5, margin: "10px 0 4px", color: "#111" }}>{children}</h3>,
        h2: ({ children }) => <h4 style={{ fontSize: 16.2, margin: "8px 0 4px", color: "#111" }}>{children}</h4>,
        p: ({ children }) => <p style={{ margin: "0 0 8px", fontSize: 15, lineHeight: 1.6, color: "#1a1a1a" }}>{children}</p>,
        ul: ({ children }) => <ul style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 15, lineHeight: 1.6 }}>{children}</ul>,
        ol: ({ children }) => <ol style={{ margin: "0 0 8px", paddingLeft: 18, fontSize: 15, lineHeight: 1.6 }}>{children}</ol>,
        li: ({ children }) => <li style={{ marginBottom: 3 }}>{children}</li>,
      }}
    >
      {markdown}
    </ReactMarkdown>
  );
}

// Renders a parsed app-builder file list for print: each file gets its own
// labeled, monospace block with break-inside avoid on the header so a
// filename never gets orphaned at the bottom of a page.
function FileTreeBody({ intro, files }: { intro: string; files: { path: string; language: string; content: string }[] }) {
  return (
    <div>
      {intro && <p style={{ fontSize: 15, lineHeight: 1.6, color: "#1a1a1a", margin: "0 0 10px" }}>{intro}</p>}
      <div style={{ fontSize: 13.1, color: "#6b7280", marginBottom: 8, fontWeight: 700 }}>
        {files.length} file{files.length !== 1 ? "s" : ""} generated
      </div>
      {files.map((file) => (
        <div key={file.path} style={{ marginBottom: 12 }}>
          <div
            style={{
              breakInside: "avoid",
              pageBreakInside: "avoid",
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: 13.1,
              fontWeight: 700,
              color: "#111",
              background: "#eef0f3",
              padding: "4px 8px",
              borderRadius: "4px 4px 0 0",
              border: "1px solid #dde1e7",
              borderBottom: "none",
            }}
          >
            {file.path}
          </div>
          <pre
            style={{
              background: "#f4f5f7",
              border: "1px solid #dde1e7",
              borderRadius: "0 0 4px 4px",
              padding: "10px 12px",
              fontFamily: "'Courier New', Courier, monospace",
              fontSize: "12.5px",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              color: "#1a1a1a",
              margin: 0,
            }}
          >
            {file.content}
          </pre>
        </div>
      ))}
    </div>
  );
}

function SubtaskSection({ subtask, index }: { subtask: Subtask; index: number }) {
  const status = STATUS_STYLE[subtask.status];

  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ breakInside: "avoid", pageBreakInside: "avoid" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
          <h2 style={{ fontSize: 18.8, fontWeight: 700, color: "#111", margin: 0 }}>
            Subtask {index + 1}
          </h2>
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 700,
              letterSpacing: "0.04em",
              color: status.color,
              background: status.bg,
              padding: "3px 8px",
              borderRadius: 3,
            }}
          >
            {status.label}
          </span>
        </div>
        <p style={{ fontSize: 15.6, color: "#333", margin: "0 0 6px", lineHeight: 1.5 }}>{subtask.description}</p>
        <div style={{ fontSize: 13.1, color: "#6b7280", marginBottom: 10 }}>
          Agent: {subtask.assignedAgent?.name || "Unassigned"} &nbsp;·&nbsp; Capability: {subtask.capability}
          &nbsp;·&nbsp; Budget: {formatUSDC(subtask.budget)}
          {subtask.settledAt && <>&nbsp;·&nbsp; Settled: {formatDate(subtask.settledAt)}</>}
        </div>
      </div>

      {subtask.status === "disputed" ? (
        <div
          style={{
            breakInside: "avoid",
            pageBreakInside: "avoid",
            background: "#fceceb",
            border: "1px solid #f3c9c5",
            borderRadius: 4,
            padding: "10px 12px",
            fontSize: 15,
            color: "#7a1f18",
            lineHeight: 1.5,
          }}
        >
          <strong>This subtask was disputed and did not settle.</strong>
          {subtask.error && <div style={{ marginTop: 4 }}>Reason: {subtask.error}</div>}
          {subtask.deliverable && (
            <div style={{ marginTop: 8, color: "#1a1a1a" }}>
              <div style={{ fontSize: 13.1, color: "#7a1f18", marginBottom: 4, fontWeight: 700 }}>
                Submitted work (not approved):
              </div>
              {(() => {
                const parsed = parseFileDeliverable(subtask.deliverable);
                return parsed
                  ? <FileTreeBody intro={parsed.intro} files={parsed.files} />
                  : <DeliverableBody markdown={subtask.deliverable} />;
              })()}
            </div>
          )}
        </div>
      ) : subtask.deliverable ? (
        (() => {
          const parsed = parseFileDeliverable(subtask.deliverable);
          return parsed
            ? <FileTreeBody intro={parsed.intro} files={parsed.files} />
            : <DeliverableBody markdown={subtask.deliverable} />;
        })()
      ) : (
        <p style={{ fontSize: 15, fontStyle: "italic", color: "#9ca3af" }}>
          No deliverable yet — this subtask is still {subtask.status}.
        </p>
      )}
    </div>
  );
}

interface Props {
  task: Task;
}

function TaskReportPrintable({ task }: Props) {
  const settledCount = task.subtasks.filter((s) => s.status === "settled").length;
  const disputedCount = task.subtasks.filter((s) => s.status === "disputed").length;
  const paidOut = task.subtasks
    .filter((s) => s.status === "settled")
    .reduce((sum, s) => sum + s.budget, 0);

  return (
    <div
      style={{
        width: "7.5in",
        padding: "0.25in 0",
        background: "#ffffff",
        color: "#1a1a1a",
        fontFamily: "'Helvetica Neue', Arial, sans-serif",
      }}
    >
      <div style={{ breakInside: "avoid", pageBreakInside: "avoid", marginBottom: 18 }}>
        <div style={{ fontSize: 12.5, letterSpacing: "0.08em", color: "#6b7280", fontWeight: 700, marginBottom: 6 }}>
          FORGEOPS AI · TASK REPORT
        </div>
        <h1 style={{ fontSize: 25, fontWeight: 700, margin: "0 0 6px", color: "#0a0a0a", lineHeight: 1.3 }}>
          {task.description}
        </h1>
        <div style={{ fontSize: 13.1, color: "#6b7280" }}>
          Generated {formatDate(new Date().toISOString())}
          {task.onChainTaskId && <> &nbsp;·&nbsp; On-chain task #{task.onChainTaskId}</>}
          &nbsp;·&nbsp; Settled on Arc
        </div>
      </div>

      <div
        style={{
          breakInside: "avoid",
          pageBreakInside: "avoid",
          display: "flex",
          border: "1px solid #e2e5ea",
          borderRadius: 5,
          marginBottom: 22,
          overflow: "hidden",
        }}
      >
        {[
          ["Total Budget", formatUSDC(task.totalBudget)],
          ["Paid Out", formatUSDC(paidOut)],
          ["Settled", `${settledCount}/${task.subtasks.length}`],
          ["Disputed", `${disputedCount}/${task.subtasks.length}`],
        ].map(([label, value], i) => (
          <div
            key={label}
            style={{
              flex: 1,
              padding: "10px 14px",
              borderLeft: i > 0 ? "1px solid #e2e5ea" : "none",
            }}
          >
            <div style={{ fontSize: 11.9, color: "#8a94a3", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 3 }}>
              {label}
            </div>
            <div style={{ fontSize: 18.8, fontWeight: 700, color: "#111" }}>{value}</div>
          </div>
        ))}
      </div>

      {disputedCount > 0 && (
        <div
          style={{
            breakInside: "avoid",
            pageBreakInside: "avoid",
            fontSize: 14.4,
            color: "#7a1f18",
            background: "#fceceb",
            border: "1px solid #f3c9c5",
            borderRadius: 4,
            padding: "8px 12px",
            marginBottom: 20,
          }}
        >
          {disputedCount} of {task.subtasks.length} subtask{disputedCount > 1 ? "s were" : " was"} disputed and
          did not settle. See the flagged section{disputedCount > 1 ? "s" : ""} below for details.
        </div>
      )}

      {task.subtasks.map((sub, i) => (
        <SubtaskSection key={sub.id} subtask={sub} index={i} />
      ))}

      <div style={{ marginTop: 30, paddingTop: 10, borderTop: "1px solid #e2e5ea", fontSize: 11.9, color: "#9ca3af" }}>
        Generated by ForgeOps AI — Multi-Agent Automation Platform on Arc
      </div>
    </div>
  );
}

export default TaskReportPrintable;
