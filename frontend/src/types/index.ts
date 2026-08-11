export type AgentCapability =
  | "research" | "data-analysis" | "code-review" | "content-writing"
  | "summarization" | "translation" | "fact-checking" | "math-reasoning"
  | "image-analysis" | "planning" | "app-builder";

export interface AgentProfile {
  id: string;
  name: string;
  description: string;
  capabilities: AgentCapability[];
  walletAddress: string;
  walletId: string;
  pricePerTask: number;
  reputationScore: number;
  jobsCompleted: number;
  totalEarned: number;
  active: boolean;
  registeredAt: string;
}

export type TaskStatus = "pending" | "decomposing" | "assigning" | "executing" | "evaluating" | "completed" | "failed" | "cancelled";
export type SubtaskStatus = "pending" | "assigned" | "executing" | "submitted" | "evaluating" | "settled" | "disputed";

export interface Subtask {
  id: string;
  taskId: string;
  subtaskIndex: number;
  description: string;
  capability: AgentCapability;
  assignedAgent?: AgentProfile;
  budget: number;
  status: SubtaskStatus;
  deliverableHash?: string;
  deliverable?: string;
  assignedAt?: string;
  submittedAt?: string;
  settledAt?: string;
  error?: string;
  disputeReason?: string;
  retryOf?: number;
  retryCount?: number;
  completionBps?: number;
  payoutAmount?: number;
}

export interface LogEntry {
  timestamp: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  data?: Record<string, unknown>;
}

export interface Task {
  id: string;
  onChainTaskId?: number;
  requesterAddress: string;
  description: string;
  totalBudget: number;
  allocatedBudget: number;
  status: TaskStatus;
  subtasks: Subtask[];
  orchestrationLog: LogEntry[];
  txHashes: Record<string, string>;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export type WSEventType =
  | "task:created" | "task:updated" | "subtask:assigned" | "subtask:executing"
  | "subtask:submitted" | "subtask:settled" | "subtask:disputed"
  | "agent:thinking" | "agent:message" | "log:entry" | "error" | "connected";

export interface WSEvent {
  type: WSEventType;
  taskId: string;
  payload: any;
  timestamp: string;
}