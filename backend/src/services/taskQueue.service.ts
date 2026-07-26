import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { orchestrationEngine } from "./orchestration.service.js";
import { taskStore } from "./taskStore.service.js";
import { randomUUID } from "crypto";

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
const redisConnection = new Redis(redisUrl);

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
}) {
  const taskId = randomUUID();
  
  // Create an initial "queued" task so the frontend can display it immediately
  const initialTask = {
    id: taskId,
    requesterAddress: params.requesterAddress.toLowerCase(),
    description: params.description,
    totalBudget: params.budget,
    allocatedBudget: 0,
    status: "queued" as const,
    subtasks: [],
    orchestrationLog: [],
    txHashes: {},
    createdAt: new Date().toISOString(),
  };

  await taskStore.set(initialTask);
  
  // Add to queue
  const job = await taskQueue.add("create-task", { ...params, taskId });
  
  return { ...initialTask, jobId: job.id };
}