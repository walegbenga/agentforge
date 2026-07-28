import { useParams, useNavigate } from "react-router-dom";
import { useCallback } from "react";
import { useAccount } from "wagmi";
import { ArrowLeft, ExternalLink, CheckCircle, XCircle, Clock, Zap, Wallet, FileText, FileCode, FileType } from "lucide-react";
import { useTask, useWebSocket } from "../hooks/useApi";
import type { Subtask, WSEvent, SubtaskStatus, LogEntry } from "../types";

import ReactMarkdown from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import { generatePDF, downloadTaskDOCX, downloadTaskCode, hasCodeBlocks, getSafeFilename } from "../utils/exports";

const ARC_EXPLORER = "https://testnet.arcscan.app/";

const SUBTASK_STATUS: Record<SubtaskStatus, { label: string; badge: string; icon: React.ReactNode }> = {
  pending:    { label: "Pending",    badge: "badge-muted",   icon: <Clock size={10} /> },
  assigned:   { label: "Assigned",   badge: "badge-arc",     icon: <Zap size={10} /> },
  executing:  { label: "Executing",  badge: "badge-arc",     icon: <Zap size={10} /> },
  submitted:  { label: "Submitted",  badge: "badge-yellow",  icon: <Clock size={10} /> },
  evaluating: { label: "Evaluating", badge: "badge-yellow",  icon: <Clock size={10} /> },
  settled:    { label: "Settled",    badge: "badge-green",   icon: <CheckCircle size={10} /> },
  disputed:   { label: "Disputed",   badge: "badge-red",     icon: <XCircle size={10} /> },
};

export default function TaskDetail() {
  const { taskId } = useParams<{ taskId: string }>();
  const navigate = useNavigate();
  const { isConnected } = useAccount();
  const { task, refresh } = useTask(taskId ?? null);

  useWebSocket(
    useCallback((event: WSEvent) => {
      if (event.taskId !== taskId) return;
      if (!["connected", "agent:thinking"].includes(event.type)) refresh();
    }, [taskId, refresh])
  );

  if (!isConnected) {
    return (
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", height: 400, gap: 16 }}>
        <Wallet size={48} color="var(--text-muted)" style={{ opacity: 0.5 }} />
        <div style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "0.9rem", textAlign: "center" }}>Connect your wallet to view task details</div>
        <button className="btn btn-primary" onClick={() => navigate("/")}>Go to Dashboard</button>
      </div>
    );
  }

  if (!task) return <div style={{ display: "flex", justifyContent: "center", alignItems: "center", height: 300 }}><div style={{ color: "var(--text-muted)" }}>Loading task...</div></div>;

  const budgetUSDC = (task.totalBudget / 1_000_000).toFixed(2);
  const allocatedUSDC = (task.allocatedBudget / 1_000_000).toFixed(2);
  const settledCount = task.subtasks.filter((s) => s.status === "settled").length;
  const totalEarned = task.subtasks.filter((s) => s.status === "settled").reduce((sum, s) => sum + s.budget, 0);
  const hasTxHashes = Object.keys(task.txHashes || {}).length > 0;
  const showCodeButton = hasCodeBlocks(task);

  // ✅ NUCLEAR OPTION: Manipulate the ORIGINAL element directly
  const handleExportPDF = async () => {
    const originalElement = document.getElementById("task-full-report");
    if (!originalElement) {
      console.error("❌ Element #task-full-report not found!");
      return;
    }

    console.log("📏 ORIGINAL HTML LENGTH:", originalElement.innerHTML.length);

    // 1. Save the original styles so we can revert them later
    const originalStyles = {
      position: originalElement.style.position,
      left: originalElement.style.left,
      top: originalElement.style.top,
      opacity: originalElement.style.opacity,
      pointerEvents: originalElement.style.pointerEvents,
      zIndex: originalElement.style.zIndex,
      width: originalElement.style.width,
    };

    // 2. Force the ORIGINAL element to be visible and on top
    originalElement.style.position = "fixed";
    originalElement.style.left = "0";
    originalElement.style.top = "0";
    originalElement.style.width = "100vw";
    originalElement.style.zIndex = "99999";
    originalElement.style.opacity = "1";
    originalElement.style.pointerEvents = "auto";
    originalElement.style.backgroundColor = "#ffffff";
    originalElement.style.color = "#000000";
    originalElement.style.padding = "40px";

    // 3. Wait for the browser to paint the original element
    await new Promise(resolve => setTimeout(resolve, 500));
    await document.fonts.ready;

    try {
      const filename = getSafeFilename(task.description, "pdf");
      await generatePDF(originalElement, filename);
    } catch (err) {
      console.error("PDF export failed", err);
      alert("Failed to generate PDF. Please try again.");
    } finally {
      // 4. IMMEDIATELY revert the styles to hide it again
      originalElement.style.position = originalStyles.position || "absolute";
      originalElement.style.left = originalStyles.left || "-9999px";
      originalElement.style.top = originalStyles.top || "0";
      originalElement.style.opacity = originalStyles.opacity || "0";
      originalElement.style.pointerEvents = originalStyles.pointerEvents || "none";
      originalElement.style.zIndex = originalStyles.zIndex || "-9999";
      originalElement.style.width = originalStyles.width || "800px";
      originalElement.style.backgroundColor = "";
      originalElement.style.color = "";
      originalElement.style.padding = "";
    }
  };

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <button className="btn btn-ghost" onClick={() => navigate("/")} style={{ marginBottom: 20, fontSize: "0.8rem" }}>
        <ArrowLeft size={14} /> Dashboard
      </button>

      {/* Header */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <StatusBadge status={task.status} />
              {task.onChainTaskId && <span className="badge badge-arc">On-Chain #{task.onChainTaskId}</span>}
            </div>
            <p style={{ fontSize: "0.9rem", color: "var(--text-primary)", lineHeight: 1.6 }}>{task.description}</p>
          </div>
        </div>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
          <MiniStat label="Budget" value={`$${budgetUSDC}`} color="var(--arc)" />
          <MiniStat label="Allocated" value={`$${allocatedUSDC}`} color="var(--yellow)" />
          <MiniStat label="Subtasks" value={`${settledCount}/${task.subtasks.length}`} color="var(--text-secondary)" />
          <MiniStat label="Paid Out" value={`$${(totalEarned / 1_000_000).toFixed(4)}`} color="var(--green)" />
        </div>

        {/* Export Buttons */}
        {settledCount > 0 && (
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.08em" }}>
              Export Full Report
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
              <button className="btn btn-ghost" style={{ fontSize: "0.75rem", display: "flex", alignItems: "center", gap: 6 }} onClick={handleExportPDF}>
                <FileText size={14} /> Download PDF
              </button>
              <button className="btn btn-ghost" style={{ fontSize: "0.75rem", display: "flex", alignItems: "center", gap: 6 }} onClick={() => downloadTaskDOCX(task)}>
                <FileType size={14} /> Download Word (.docx)
              </button>
              {showCodeButton && (
                <button className="btn btn-ghost" style={{ fontSize: "0.75rem", display: "flex", alignItems: "center", gap: 6, color: "var(--arc)" }} onClick={() => downloadTaskCode(task)}>
                  <FileCode size={14} /> Download Source Code
                </button>
              )}
            </div>
          </div>
        )}

        {hasTxHashes && (
          <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--border)" }}>
            <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.08em" }}>On-chain Transactions</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {Object.entries(task.txHashes).map(([label, hash]) => (
                <a key={label} href={`${ARC_EXPLORER}/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="badge badge-muted" style={{ textDecoration: "none", cursor: "pointer" }}>
                  {label} <ExternalLink size={9} />
                </a>
              ))}
            </div>
          </div>
        )}
        <div style={{ marginTop: 10, fontSize: "0.7rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>Submitted by: {task.requesterAddress}</div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20 }}>
        {/* Subtasks */}
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.8rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Subtasks</div>
          {task.subtasks.length === 0 ? (
            <div className="card" style={{ textAlign: "center", padding: 32, color: "var(--text-muted)", fontSize: "0.8rem" }}>
              {["decomposing", "pending"].includes(task.status) ? "Orchestrator is planning subtasks..." : "No subtasks yet"}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {task.subtasks.map((subtask, i) => (
                <SubtaskCard key={subtask.id} subtask={subtask} index={i} />
              ))}
            </div>
          )}
        </div>

        {/* Log */}
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.8rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>Orchestration Log</div>
          <div className="card" style={{ padding: 0 }}>
            <div className="log-container" style={{ padding: 8, maxHeight: 420 }}>
              {task.orchestrationLog.length === 0 ? (
                <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: "0.8rem" }}>Waiting for orchestrator...</div>
              ) : (
                [...task.orchestrationLog].reverse().map((entry, i) => <LogLine key={i} entry={entry} />)
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ✅ HIDDEN CONTAINER: Completely hidden initially, rendered by React */}
      <div 
        id="task-full-report" 
        style={{ 
          position: "absolute", 
          left: "-9999px", 
          top: "0", 
          width: "800px",
          opacity: 0,
          pointerEvents: "none",
          zIndex: -9999
        }}
      >
        <h1 style={{ fontSize: "24px", marginBottom: "10px", color: "#111827" }}>{task.description}</h1>
        <p style={{ fontSize: "14px", color: "#6b7280", marginBottom: "30px" }}>Generated by AgentForge on Arc Blockchain</p>
        <hr style={{ marginBottom: "30px", borderColor: "#e5e7eb" }} />
        
        {task.subtasks.map((sub, i) => (
          <div key={sub.id} style={{ marginBottom: "40px" }}>
            <h2 style={{ fontSize: "20px", color: "#00d4ff", marginBottom: "10px" }}>Subtask {i + 1}: {sub.description}</h2>
            <div style={{ fontSize: "12px", color: "#9ca3af", marginBottom: "15px" }}>
              Agent: {sub.assignedAgent?.name || "Unassigned"} | Status: {sub.status}
            </div>
            
            {sub.deliverable ? (
              <div style={{ fontSize: "14px", lineHeight: "1.6" }}>
                <ReactMarkdown>{sub.deliverable}</ReactMarkdown>
              </div>
            ) : (
              <p style={{ fontStyle: "italic", color: "#999" }}>No deliverable provided for this subtask.</p>
            )}
            <hr style={{ marginTop: "30px", borderColor: "#eee" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// SubtaskCard
function SubtaskCard({ subtask, index }: { subtask: Subtask; index: number }) {
  const cfg = SUBTASK_STATUS[subtask.status];
  const budgetUSDC = (subtask.budget / 1_000_000).toFixed(4);
  const isActive = ["executing", "assigned"].includes(subtask.status);

  return (
    <div className="card animate-fade-in" style={{ padding: "14px 16px", borderColor: isActive ? "var(--arc)" : "var(--border)", boxShadow: isActive ? "0 0 8px rgba(0,212,255,0.1)" : "none", transition: "all 0.3s" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.7rem", color: "var(--text-muted)" }}>#{index + 1}</span>
          <span className={`badge ${cfg.badge}`}>{isActive && <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>}{cfg.label}</span>
          <span className="badge badge-muted" style={{ fontSize: "0.65rem" }}>{subtask.capability}</span>
        </div>
        <span className="badge badge-usdc">${budgetUSDC}</span>
      </div>

      <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginBottom: 10, lineHeight: 1.5 }}>{subtask.description}</p>

      {subtask.assignedAgent && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}>
          <div style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--arc-dim)", border: "1px solid rgba(0,212,255,0.3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "0.7rem" }}>🤖</div>
          <div>
            <div style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-primary)" }}>{subtask.assignedAgent.name}</div>
            <div style={{ fontSize: "0.65rem", color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>Rep: {subtask.assignedAgent.reputationScore}/100</div>
          </div>
          {subtask.status === "settled" && <div style={{ marginLeft: "auto", color: "var(--green)", fontSize: "0.7rem", fontFamily: "var(--font-mono)" }}>✓ Paid</div>}
        </div>
      )}

      {subtask.deliverable && subtask.status === "settled" && (
        <div style={{ marginTop: 12, padding: 16, background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)", fontSize: "0.85rem", color: "var(--text-secondary)", lineHeight: 1.6, maxHeight: 400, overflow: "auto" }}>
          <ReactMarkdown
            components={{
              code({ node, inline, className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || "");
                return !inline && match ? (
                  <SyntaxHighlighter style={vscDarkPlus} language={match[1]} PreTag="div" {...props}>{String(children).replace(/\n$/, "")}</SyntaxHighlighter>
                ) : (
                  <code className={className} style={{ background: "var(--bg-hover)", padding: "2px 4px", borderRadius: 4, fontSize: "0.8em" }} {...props}>{children}</code>
                );
              },
              h1: ({children}) => <h1 style={{color: "var(--text-primary)", fontSize: "1.2rem", marginBottom: "8px"}}>{children}</h1>,
              h2: ({children}) => <h2 style={{color: "var(--text-primary)", fontSize: "1.1rem", marginBottom: "6px"}}>{children}</h2>,
              ul: ({children}) => <ul style={{marginBottom: "8px", paddingLeft: "20px"}}>{children}</ul>,
              p: ({children}) => <p style={{marginBottom: "8px"}}>{children}</p>,
            }}
          >
            {subtask.deliverable}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  const colors: Record<string, string> = { success: "var(--green)", warning: "var(--yellow)", error: "var(--red)", info: "var(--text-secondary)" };
  return (
    <div style={{ display: "flex", gap: 8, padding: "5px 8px", borderRadius: "var(--radius)", fontSize: "0.72rem", lineHeight: 1.5 }}>
      <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", flexShrink: 0, fontSize: "0.65rem", marginTop: 1 }}>{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      <span style={{ color: colors[entry.level], flex: 1, wordBreak: "break-word" }}>{entry.message}</span>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = { pending: "badge-muted", decomposing: "badge-yellow", assigning: "badge-arc", executing: "badge-arc", evaluating: "badge-yellow", completed: "badge-green", failed: "badge-red", cancelled: "badge-muted" };
  const active = ["decomposing", "assigning", "executing", "evaluating"].includes(status);
  return (<span className={`badge ${map[status] || "badge-muted"}`}>{active && <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>⟳</span>}{status.charAt(0).toUpperCase() + status.slice(1)}</span>);
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (<div style={{ padding: "10px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)" }}><div style={{ fontSize: "0.65rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div><div style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: "1rem", color }}>{value}</div></div>);
}