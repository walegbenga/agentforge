import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis"; // ✅ Named import is required for ESM
import { orchestrationEngine } from "./orchestration.service.js";
import { taskStore } from "./taskStore.service.js";
import { randomUUID } from "crypto";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

// ✅ CRITICAL FIX: maxRetriesPerRequest MUST be null for BullMQ to work
const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});

// 1. Define the Queue
export const taskQueue = new Queue("task-creation", { connection: redisConnection });

// How many tasks' full orchestration pipelines run AT ONCE, platform-wide.
// This is real backpressure now that createAndRunTask() actually awaits
// the whole decompose→build→evaluate chain instead of firing it in the
// background — before that fix, this setting didn't meaningfully limit
// anything, since each "job" completed almost instantly regardless of how
// long the real work took.
//
// Tune this against your actual LLM provider's rate limit, not a guess:
// a single app-builder call alone can request up to 8000 tokens, and a
// multi-module build issues several calls per task (planning, each
// module, code-review, evaluations). If WORKER_CONCURRENCY × your
// typical concurrent-calls-per-task exceeds your provider's tokens/minute
// ceiling, tasks will queue behind rate-limit backoffs (see
// callGroqWithRateLimitRetry in orchestration.service.ts) instead of
// failing outright — safe, but slower than it needs to be. Lower this if
// you're seeing frequent rate-limit waits; raise it once you've upgraded
// your LLM plan.
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || "5", 10);

// 2. Define the Worker (runs in the background)
export const taskWorker = new Worker(
  "task-creation",
  async (job) => {
    console.log(`🔄 [Worker] Processing job ${job.id} for task creation...`);
    try {
      // The heavy lifting: Blockchain calls + AI decomposition. This is
      // now genuinely awaited end-to-end (see the fix in
      // orchestration.service.ts), so this job doesn't resolve until the
      // task's entire pipeline actually finishes.
      await orchestrationEngine.createAndRunTask(job.data);
      console.log(`✅ [Worker] Job ${job.id} completed successfully`);
    } catch (error) {
      // Note: createAndRunTask catches its own orchestration failures
      // internally (marks the task failed, attempts an on-chain refund)
      // and does NOT re-throw — so in practice this catch only fires for
      // genuinely unexpected errors (e.g. a DB write failure), not normal
      // task-level failures. BullMQ's default job `attempts` is 1 (no
      // automatic retry) unless explicitly configured on taskQueue.add();
      // that's not currently set, so a job that does throw here fails
      // once and stays failed — it does not silently retry.
      console.error(`❌ [Worker] Job ${job.id} failed:`, error);
      throw error;
    }
  },
  { connection: redisConnection, concurrency: WORKER_CONCURRENCY }
);

// 3. Helper to queue a task

export async function queueTaskCreation(params: {
  description: string;
  budget: number;
  requesterAddress: string;
  onChainTaskId?: string;
  createTaskTxHash?: string;
}) {
  const taskId = randomUUID();
  const userFunded = !!(params.onChainTaskId && params.createTaskTxHash);

  const initialTask = {
    id: taskId,
    requesterAddress: params.requesterAddress.toLowerCase(),
    description: params.description,
    totalBudget: params.budget,
    allocatedBudget: 0,
    status: "pending" as const,
    subtasks: [],
    orchestrationLog: [
      {
        timestamp: new Date().toISOString(),
        level: "info" as const,
        message: userFunded
          ? "Task received — on-chain payment confirmed, queued for processing"
          : "Task received and queued for background processing",
      }
    ],
    txHashes: (userFunded ? { createTask: params.createTaskTxHash as string } : {}) as Record<string, string>,
    onChainTaskId: params.onChainTaskId,
    userFunded,
    createdAt: new Date().toISOString(),
  };

  await taskStore.set(initialTask);
  
  // ✅ CRITICAL: Pass the taskId to the worker so it reuses it
  const job = await taskQueue.add("create-task", { ...params, taskId });
  
  return { ...initialTask, jobId: job.id };
}