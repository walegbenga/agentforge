// ─── Agent Types ──────────────────────────────────────────────────────────────

export type AgentCapability =
  | "research"
  | "data-analysis"
  | "code-review"
  | "content-writing"
  | "summarization"
  | "translation"
  | "fact-checking"
  | "math-reasoning"
  | "image-analysis"
  | "planning"
  | "app-builder";

export interface AgentProfile {
  id: string;               // UUID internal
  name: string;
  description: string;
  capabilities: AgentCapability[];
  walletAddress: string;    // Circle Developer-Controlled Wallet
  // ✅ REMOVED: walletId: string;
  // ✅ REMOVED: erc8004AgentId?: string;
  pricePerTask: number;     // USDC (6 decimals)
  reputationScore: number;  // 0-100
  jobsCompleted: number;
  totalEarned: number;      // USDC (6 decimals)
  active: boolean;
  registeredAt: string;
}

// ─── Task Types ───────────────────────────────────────────────────────────────

export type TaskStatus =
  | "pending"
  | "decomposing"
  | "assigning"
  | "executing"
  | "evaluating"
  | "completed"
  | "failed"
  | "cancelled";

export type SubtaskStatus =
  | "pending"
  | "assigned"
  | "executing"
  | "submitted"
  | "evaluating"
  | "settled"
  | "disputed";

export interface Subtask {
  id: string;
  taskId: string;
  subtaskIndex: number;
  description: string;
  capability: AgentCapability;
  assignedAgent?: AgentProfile;
  budget: number;           // USDC (6 decimals)
  status: SubtaskStatus;
  deliverableHash?: string;
  deliverable?: string;     // actual output (stored off-chain)
  onChainSubtaskIndex?: number;
  assignedAt?: string;
  submittedAt?: string;
  settledAt?: string;
  error?: string;
  disputeReason?: string;   // why the evaluator rejected it — persisted so it survives a page reload, not just a live WS event
  retryOf?: number;         // subtaskIndex of the original attempt, if this subtask is a retry
  retryCount?: number;      // how many retries have happened for this line of work (0 = original attempt)
}

export interface Task {
  id: string;
  onChainTaskId?: string;
  requesterAddress: string;
  description: string;
  totalBudget: number;      // USDC (6 decimals)
  allocatedBudget: number;
  status: TaskStatus;
  subtasks: Subtask[];
  orchestrationLog: LogEntry[];
  txHashes: Record<string, string>; // label → txHash
  createdAt: string;
  completedAt?: string;
  error?: string;
  userFunded?: boolean; // true when the requester's own wallet paid on-chain
}

// ─── Orchestration Types ──────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface DecompositionResult {
  subtasks: Array<{
    description: string;
    capability: AgentCapability;
    estimatedBudget: number;
    dependsOn?: number[];
  }>;
  orchestrationPlan: string;
  estimatedTotalCost: number;
}

export interface EvaluationResult {
  approved: boolean;
  score: number;       // 0-100
  feedback: string;
  deliverableHash: string;
}

// ─── WebSocket Events ─────────────────────────────────────────────────────────

export type WSEventType =
  | "task:created"
  | "task:updated"
  | "subtask:assigned"
  | "subtask:executing"
  | "subtask:submitted"
  | "subtask:settled"
  | "subtask:disputed"
  | "agent:thinking"
  | "agent:message"
  | "log:entry"
  | "error";

export interface WSEvent {
  type: WSEventType;
  taskId: string;
  payload: unknown;
  timestamp: string;
}

// ─── API Types ────────────────────────────────────────────────────────────────

export interface CreateTaskRequest {
  description: string;
  budget: number;         // USDC (6 decimals)
  requesterAddress: string;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}