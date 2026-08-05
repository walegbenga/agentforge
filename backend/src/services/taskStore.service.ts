import { prisma } from "./db.service.js";
import type { Task, Subtask, AgentProfile } from "../types/index.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function dbTaskToTask(dbTask: any): Task {
  return {
    id: dbTask.id,
    onChainTaskId: dbTask.onChainTaskId ?? undefined,
    requesterAddress: dbTask.requesterAddress,
    description: dbTask.description,
    totalBudget: dbTask.totalBudget,
    allocatedBudget: dbTask.allocatedBudget,
    status: dbTask.status as Task["status"],
    txHashes: (dbTask.txHashes as Record<string, string>) || {},
    orchestrationLog: (dbTask.orchestrationLog as any[]) || [],
    error: dbTask.error ?? undefined,
    completedAt: dbTask.completedAt?.toISOString() ?? undefined,
    createdAt: dbTask.createdAt.toISOString(),
    subtasks: (dbTask.subtasks || []).map(dbSubtaskToSubtask),
  };
}

function dbSubtaskToSubtask(s: any): Subtask {
  return {
    id: s.id,
    taskId: s.taskId,
    subtaskIndex: s.subtaskIndex,
    description: s.description,
    capability: s.capability as Subtask["capability"],
    budget: s.budget,
    status: s.status as Subtask["status"],
    deliverableHash: s.deliverableHash ?? undefined,
    deliverable: s.deliverable ?? undefined,
    onChainSubtaskIndex: s.onChainSubtaskIndex ?? undefined,
    error: s.error ?? undefined,
    disputeReason: s.disputeReason ?? undefined,
    retryOf: s.retryOf ?? undefined,
    retryCount: s.retryCount ?? undefined,
    assignedAt: s.assignedAt?.toISOString() ?? undefined,
    submittedAt: s.submittedAt?.toISOString() ?? undefined,
    settledAt: s.settledAt?.toISOString() ?? undefined,
    assignedAgent: s.assignedAgentId
      ? {
          id: s.assignedAgentId,
          name: s.assignedAgentName || "",
          walletAddress: s.assignedAgentWallet || "",
          reputationScore: s.assignedAgentRep || 70,
        } as AgentProfile
      : undefined,
  };
}

// ── Task Store ─────────────────────────────────────────────────────────────

class TaskStoreService {

  async set(task: Task): Promise<void> {
    await prisma.task.upsert({
      where: { id: task.id },
      create: {
        id: task.id,
        requesterAddress: task.requesterAddress,
        description: task.description,
        totalBudget: task.totalBudget,
        allocatedBudget: task.allocatedBudget,
        status: task.status,
        txHashes: task.txHashes,
        orchestrationLog: task.orchestrationLog as any, // <-- FIXED HERE
        error: task.error ?? null,
        completedAt: task.completedAt ? new Date(task.completedAt) : null,
        onChainTaskId: task.onChainTaskId ?? null,
      },
      update: {
        allocatedBudget: task.allocatedBudget,
        status: task.status,
        txHashes: task.txHashes,
        orchestrationLog: task.orchestrationLog as any, // <-- FIXED HERE
        error: task.error ?? null,
        completedAt: task.completedAt ? new Date(task.completedAt) : null,
        onChainTaskId: task.onChainTaskId ?? null,
      },
    });

    // Upsert all subtasks
    for (const subtask of task.subtasks) {
      await prisma.subtask.upsert({
        where: { id: subtask.id },
        create: {
          id: subtask.id,
          taskId: task.id,
          subtaskIndex: subtask.subtaskIndex,
          description: subtask.description,
          capability: subtask.capability,
          budget: subtask.budget,
          status: subtask.status,
          deliverableHash: subtask.deliverableHash ?? null,
          deliverable: subtask.deliverable ?? null,
          onChainSubtaskIndex: subtask.onChainSubtaskIndex ?? null,
          assignedAgentId: subtask.assignedAgent?.id ?? null,
          assignedAgentName: subtask.assignedAgent?.name ?? null,
          assignedAgentWallet: subtask.assignedAgent?.walletAddress ?? null,
          assignedAgentRep: subtask.assignedAgent?.reputationScore ?? null,
          error: subtask.error ?? null,
          disputeReason: subtask.disputeReason ?? null,
          retryOf: subtask.retryOf ?? null,
          retryCount: subtask.retryCount ?? 0,
          assignedAt: subtask.assignedAt ? new Date(subtask.assignedAt) : null,
          submittedAt: subtask.submittedAt ? new Date(subtask.submittedAt) : null,
          settledAt: subtask.settledAt ? new Date(subtask.settledAt) : null,
        },
        update: {
          status: subtask.status,
          deliverableHash: subtask.deliverableHash ?? null,
          deliverable: subtask.deliverable ?? null,
          onChainSubtaskIndex: subtask.onChainSubtaskIndex ?? null,
          assignedAgentId: subtask.assignedAgent?.id ?? null,
          assignedAgentName: subtask.assignedAgent?.name ?? null,
          assignedAgentWallet: subtask.assignedAgent?.walletAddress ?? null,
          assignedAgentRep: subtask.assignedAgent?.reputationScore ?? null,
          error: subtask.error ?? null,
          disputeReason: subtask.disputeReason ?? null,
          retryOf: subtask.retryOf ?? null,
          retryCount: subtask.retryCount ?? 0,
          assignedAt: subtask.assignedAt ? new Date(subtask.assignedAt) : null,
          submittedAt: subtask.submittedAt ? new Date(subtask.submittedAt) : null,
          settledAt: subtask.settledAt ? new Date(subtask.settledAt) : null,
        },
      });
    }
  }

  async get(id: string): Promise<Task | undefined> {
    const dbTask = await prisma.task.findUnique({
      where: { id },
      include: { subtasks: { orderBy: { subtaskIndex: "asc" } } },
    });
    return dbTask ? dbTaskToTask(dbTask) : undefined;
  }

  async getAll(opts?: { limit?: number; cursor?: string }): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    const limit = Math.min(opts?.limit ?? 10, 50);
    const rows = await prisma.task.findMany({
      include: { subtasks: { orderBy: { subtaskIndex: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: limit + 1, // fetch one extra to know whether there's a next page
      ...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { tasks: page.map(dbTaskToTask), nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async getByAddress(address: string, opts?: { limit?: number; cursor?: string }): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    const limit = Math.min(opts?.limit ?? 10, 50);
    const rows = await prisma.task.findMany({
      where: { requesterAddress: { equals: address, mode: "insensitive" } },
      include: { subtasks: { orderBy: { subtaskIndex: "asc" } } },
      orderBy: { createdAt: "desc" },
      take: limit + 1,
      ...(opts?.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    return { tasks: page.map(dbTaskToTask), nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /**
   * For the global /stats endpoint — needs totals across ALL tasks, not a
   * paginated page of them. Uses DB-level count/sum instead of hydrating
   * every task's full subtasks + deliverable text (which can now be entire
   * multi-file apps) just to add up some numbers.
   */
  async getStatsAggregate(): Promise<{
    totalTasks: number;
    completedTasks: number;
    totalVolume: number;
    pendingSubtasks: number;
  }> {
    const [totalTasks, completedTasks, volumeAgg, pendingSubtasks] = await Promise.all([
      prisma.task.count(),
      prisma.task.count({ where: { status: "completed" } }),
      prisma.task.aggregate({ _sum: { totalBudget: true } }),
      prisma.subtask.count({ where: { status: "pending" } }),
    ]);
    return {
      totalTasks,
      completedTasks,
      totalVolume: volumeAgg._sum.totalBudget ?? 0,
      pendingSubtasks,
    };
  }
}

export const taskStore = new TaskStoreService();