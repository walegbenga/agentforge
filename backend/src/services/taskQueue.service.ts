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

// 2. Define the Worker (runs in the background)
export const taskWorker = new Worker(
  "task-creation",
  async (job) => {
    console.log(`🔄 [Worker] Processing job ${job.id} for task creation...`);
    try {
      // The heavy lifting: Blockchain calls + AI decomposition
      await orchestrationEngine.createAndRunTask(job.data);
      console.log(`✅ [Worker] Job ${job.id} completed successfully`);
    } catch (error) {
      console.error(`❌ [Worker] Job ${job.id} failed:`, error);
      throw error; // BullMQ will automatically retry failed jobs
    }
  },
  { connection: redisConnection }
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