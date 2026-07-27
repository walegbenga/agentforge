import Groq from "groq-sdk";
import { randomUUID } from "crypto";
import { keccak256, toBytes } from "viem";
import { agentRegistry } from "./agentRegistry.service.js";
import { onChainService } from "./onchain.service.js";
import { wsService } from "./websocket.service.js";
import { taskStore } from "./taskStore.service.js";
import type {
  Task,
  Subtask,
  DecompositionResult,
  EvaluationResult,
  AgentCapability,
  LogEntry,
  AgentProfile,
} from "../types/index.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class OrchestrationEngine {

      async createAndRunTask(params: {
    description: string;
    budget: number;
    requesterAddress: string;
    taskId?: string; // ✅ Added: Allow passing existing taskId from queue
  }): Promise<Task> {
    // ✅ Reuse the provided taskId, or generate a new one if called directly
    const taskId = params.taskId || randomUUID();

    const task: Task = {
      id: taskId,
      requesterAddress: params.requesterAddress.toLowerCase(),
      description: params.description,
      totalBudget: params.budget,
      allocatedBudget: 0,
      status: "decomposing", // ✅ Worker takes over, so start at decomposing
      subtasks: [],
      orchestrationLog: [
        {
          timestamp: new Date().toISOString(),
          level: "info" as const,
          message: "Background worker started processing task",
        }
      ],
      txHashes: {},
      createdAt: new Date().toISOString(),
    };

    await taskStore.set(task);
    
    this.emit(task, "task:created", {
      taskId,
      description: params.description,
      budget: params.budget,
    });

    this.runOrchestration(task).catch((err) => {
      task.status = "failed";
      task.error = err.message;
      this.log(task, "error", `Orchestration failed: ${err.message}`);
      this.emit(task, "task:updated", { status: "failed", error: err.message });
      taskStore.set(task).catch(console.error);
    });

    return task;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return await taskStore.get(taskId);
  }

  async getAllTasks(): Promise<Task[]> {
    return await taskStore.getAll();
  }

  async getTasksByAddress(address: string): Promise<Task[]> {
    // ✅ Normalize address when searching to ensure exact matches
    return await taskStore.getByAddress(address.toLowerCase());
  }

  // ✅ NEW: Agent claims a pending subtask
  async claimSubtask(taskId: string, subtaskIndex: number, walletAddress: string): Promise<Task> {
    const task = await taskStore.get(taskId);
    if (!task) throw new Error("Task not found");

    const subtask = task.subtasks.find(s => s.subtaskIndex === subtaskIndex);
    if (!subtask) throw new Error("Subtask not found");
    if (subtask.status !== "pending") throw new Error("Subtask is not available for claiming");

    const agent = await agentRegistry.getOrCreateAgent(walletAddress);

    subtask.assignedAgent = agent;
    subtask.status = "assigned";
    subtask.assignedAt = new Date().toISOString();

    await taskStore.set(task);

    this.log(task, "success", `${agent.name} claimed subtask ${subtaskIndex}`);
    this.emit(task, "subtask:assigned", {
      subtaskIndex,
      agentName: agent.name,
      capability: subtask.capability,
      budget: subtask.budget,
      status: "assigned",
    });

    return task;
  }

  private async runOrchestration(task: Task): Promise<void> {
    await this.createOnChainTask(task);

    task.status = "decomposing";
    this.emit(task, "task:updated", { status: "decomposing" });
    await taskStore.set(task);

    const decomposition = await this.decomposeTask(task);

    task.status = "assigning";
    this.emit(task, "task:updated", { status: "assigning" });
    await taskStore.set(task);

    await this.assignAgents(task, decomposition);

    // ✅ Check if any subtasks got agents
    const hasAssigned = task.subtasks.some(s => s.assignedAgent);
    const pendingCount = task.subtasks.filter(s => s.status === "pending").length;

    if (!hasAssigned) {
      task.status = "pending";
      this.log(task, "warning", `All ${task.subtasks.length} subtasks are pending. Waiting for agents to claim.`);
      this.emit(task, "task:updated", { status: "pending" });
      await taskStore.set(task);
      return; // ✅ Stop here, don't crash
    }

    if (pendingCount > 0) {
      this.log(task, "info", `${pendingCount} subtask(s) still pending, ${task.subtasks.length - pendingCount} assigned`);
    }

    task.status = "executing";
    this.emit(task, "task:updated", { status: "executing" });
    await taskStore.set(task);

    await this.executeSubtasks(task);

    task.status = "evaluating";
    this.emit(task, "task:updated", { status: "evaluating" });
    await taskStore.set(task);

    await this.evaluateAndSettle(task);

    // ✅ Check if ALL subtasks are settled before marking completed
    const allSettled = task.subtasks.every(
      s => s.status === "settled" || s.status === "disputed"
    );

    if (allSettled) {
      task.status = "completed";
      task.completedAt = new Date().toISOString();
      await taskStore.set(task);
      this.emit(task, "task:updated", {
        status: "completed",
        completedAt: task.completedAt,
      });
      this.log(task, "success", "✓ Task completed successfully");
    } else {
      task.status = "pending";
      this.log(task, "info", "Task partially completed. Waiting for remaining subtasks.");
      this.emit(task, "task:updated", { status: "pending" });
      await taskStore.set(task);
    }
  }

  private async createOnChainTask(task: Task): Promise<void> {
    this.log(task, "info", "Creating on-chain task and locking USDC in escrow...");
    try {
      const approveTx = await onChainService.approveEscrow({ amount: task.totalBudget });
      task.txHashes["approve"] = approveTx;
      this.log(task, "info", `USDC approved for escrow`, { txHash: approveTx });

      const { taskId, txHash } = await onChainService.createTask({
        description: task.description,
        budget: task.totalBudget,
      });

      task.onChainTaskId = taskId;
      task.txHashes["createTask"] = txHash;
      await taskStore.set(task);
      this.log(task, "success", `Task locked on Arc: taskId=${taskId}`, { txHash });
    } catch (err) {
      this.log(task, "warning", `On-chain task creation skipped: ${(err as Error).message}`);
    }
  }

  private async decomposeTask(task: Task): Promise<DecompositionResult> {
    this.log(task, "info", "Orchestrator decomposing task...");
    this.emit(task, "agent:thinking", { agent: "Orchestrator", message: "Analyzing task requirements..." });

    const validCapabilities: AgentCapability[] = [
      "research", "data-analysis", "code-review", "content-writing",
      "summarization", "translation", "fact-checking", "math-reasoning",
      "image-analysis", "planning",
    ];

    const totalBudgetUSDC = task.totalBudget / 1_000_000;
    const allAgents = await agentRegistry.getAll();
    const availableAgents = allAgents.map((a: any) => ({
      name: a.name,
      capabilities: a.capabilities,
      pricePerTask: a.pricePerTask / 1_000_000,
      reputationScore: a.reputationScore,
    }));

    const prompt = `You are the orchestrator of an AI agent economy. Break down this task into subtasks that can be assigned to specialist agents.

TASK: ${task.description}
BUDGET: ${totalBudgetUSDC} USDC total

AVAILABLE AGENTS:
${availableAgents.length > 0 ? JSON.stringify(availableAgents, null, 2) : "No agents registered yet. Use all valid capabilities."}

VALID CAPABILITIES: ${validCapabilities.join(", ")}

Return ONLY valid JSON (no markdown, no backticks):
{
  "orchestrationPlan": "brief plan description",
  "estimatedTotalCost": <number in USDC>,
  "subtasks": [
    {
      "description": "specific subtask description",
      "capability": "<one of the valid capabilities>",
      "estimatedBudget": <USDC amount as number>,
      "dependsOn": []
    }
  ]
}

Rules:
- Max 6 subtasks
- Each subtask maps to ONE capability
- Total budget must not exceed ${totalBudgetUSDC} USDC
- Return ONLY the JSON object, nothing else`;

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1500,
      temperature: 0.3,
      messages: [{ role: "user", content: prompt }],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const result: DecompositionResult = JSON.parse(clean);

    this.log(task, "success", `Decomposed into ${result.subtasks.length} subtasks`, {
      plan: result.orchestrationPlan,
    });
    this.emit(task, "agent:message", { agent: "Orchestrator", message: result.orchestrationPlan });
    await taskStore.set(task);
    return result;
  }

  private async assignAgents(task: Task, decomposition: DecompositionResult): Promise<void> {
    // ✅ Get the requester as a potential agent
    const requesterAgent = await agentRegistry.getOrCreateAgent(task.requesterAddress);

    for (let i = 0; i < decomposition.subtasks.length; i++) {
      const sub = decomposition.subtasks[i];
      const budgetMicro = Math.floor(sub.estimatedBudget * 1_000_000);

      // Try to find the best agent for this capability
      let agent = await agentRegistry.getBestAgent(sub.capability as AgentCapability);

      // ✅ If no specialist found, check if the requester can do it
      if (!agent && requesterAgent.capabilities.includes(sub.capability as AgentCapability)) {
        agent = requesterAgent;
        this.log(task, "info", `Requester ${requesterAgent.name} can handle subtask ${i + 1} (${sub.capability})`);
      }

      // ✅ ALWAYS create the subtask, even without an agent
      const subtask: Subtask = {
        id: randomUUID(),
        taskId: task.id,
        subtaskIndex: i,
        description: sub.description,
        capability: sub.capability as AgentCapability,
        assignedAgent: agent || undefined,
        budget: budgetMicro,
        status: agent ? "assigned" : "pending",
        assignedAt: agent ? new Date().toISOString() : undefined,
      };

      task.subtasks.push(subtask);
      task.allocatedBudget += budgetMicro;

      // Only do on-chain assignment if agent exists
      if (agent) {
        try {
          const txHash = await onChainService.assignSubtask({
            taskId: task.onChainTaskId!,
            agentWallet: agent.walletAddress as `0x${string}`,
            capability: sub.capability as AgentCapability,
            budget: budgetMicro,
            description: sub.description,
          });
          subtask.onChainSubtaskIndex = i;
          task.txHashes[`assign-${i}`] = txHash;
        } catch {}

        this.log(task, "info", `Subtask ${i + 1} → ${agent.name} (${sub.capability})`, {
          budget: sub.estimatedBudget,
        });
      } else {
        this.log(task, "warning", `Subtask ${i + 1} pending — no agent for: ${sub.capability}. Open for claiming.`);
      }

      await taskStore.set(task);

      this.emit(task, "subtask:assigned", {
        subtaskIndex: i,
        agentName: agent?.name || "Unassigned",
        capability: sub.capability,
        budget: budgetMicro,
        status: subtask.status,
      });
    }
  }

  private async executeSubtasks(task: Task): Promise<void> {
    // ✅ Only execute subtasks that have agents assigned
    const readySubtasks = task.subtasks.filter(s => s.assignedAgent);
    if (readySubtasks.length === 0) {
      this.log(task, "info", "No subtasks ready for execution");
      return;
    }
    await Promise.all(readySubtasks.map((s) => this.executeSubtask(task, s)));
  }

  // Inside executeSubtask method:
const response = await groq.chat.completions.create({
  model: "llama-3.3-70b-versatile",
  max_tokens: 4000, // Increased to allow for longer, formatted reports
  temperature: 0.5,
  messages: [
    { 
      role: "system", 
      content: `${this.buildAgentSystemPrompt(agent.name, subtask.capability)}

IMPORTANT FORMATTING RULES:
- You MUST output your deliverable using Markdown formatting.
- Use # for main titles, ## for subtitles, and bullet points for lists.
- If you are writing code, you MUST wrap it in code blocks with the language specified (e.g., \`\`\`javascript ... \`\`\` or \`\`\`solidity ... \`\`\`).
- Do not just output a wall of text. Structure it professionally.` 
    },
    {
      role: "user",
      content: `TASK CONTEXT: ${task.description}\n\nYOUR SUBTASK: ${subtask.description}\n\nDeliver your work now. Be thorough, specific, and professionally formatted.`,
    },
  ],
});

  private async evaluateAndSettle(task: Task): Promise<void> {
    for (const subtask of task.subtasks) {
      if (subtask.status !== "submitted") continue;
      const evaluation = await this.evaluateDeliverable(task, subtask);

      if (evaluation.approved) {
        subtask.status = "settled";
        subtask.settledAt = new Date().toISOString();
        await agentRegistry.recordCompletion(subtask.assignedAgent!.id, subtask.budget);
        await taskStore.set(task);

        this.log(task, "success",
          `✓ ${subtask.assignedAgent!.name} settled — score ${evaluation.score}/100`,
          { payout: subtask.budget / 1_000_000 }
        );
        this.emit(task, "subtask:settled", {
          subtaskIndex: subtask.subtaskIndex,
          agentName: subtask.assignedAgent!.name,
          score: evaluation.score,
          payout: subtask.budget,
          txHash: task.txHashes[`settle-${subtask.subtaskIndex}`],
        });
      } else {
        subtask.status = "disputed";
        await agentRegistry.recordDispute(subtask.assignedAgent!.id);
        await taskStore.set(task);

        this.log(task, "warning",
          `✗ ${subtask.assignedAgent!.name} disputed — ${evaluation.feedback}`
        );
        this.emit(task, "subtask:disputed", {
          subtaskIndex: subtask.subtaskIndex,
          reason: evaluation.feedback,
        });
      }
    }
  }

  private async evaluateDeliverable(task: Task, subtask: Subtask): Promise<EvaluationResult> {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      temperature: 0.1,
      messages: [{
        role: "user",
        content: `Evaluate this deliverable for quality and relevance.

ORIGINAL TASK: ${task.description}
SUBTASK: ${subtask.description}
DELIVERABLE: ${subtask.deliverable}

Return ONLY valid JSON (no markdown):
{
  "approved": <true/false>,
  "score": <0-100>,
  "feedback": "<brief evaluation>"
}`,
      }],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    return { ...result, deliverableHash: subtask.deliverableHash! };
  }

  private buildAgentSystemPrompt(agentName: string, capability: AgentCapability): string {
    const personas: Record<AgentCapability, string> = {
      research: "You are ResearchBot, an expert at deep web research, source aggregation, and comprehensive information gathering.",
      "data-analysis": "You are AnalyticsBot, specializing in data analysis, statistical reasoning, and pattern recognition.",
      "code-review": "You are CodeReviewBot, an expert code reviewer focused on quality, security, and best practices.",
      "content-writing": "You are WriterBot, creating compelling, accurate, and well-structured written content.",
      summarization: "You are SummaryBot, distilling complex information into clear, concise summaries.",
      translation: "You are TranslationBot, providing accurate and culturally-aware translations.",
      "fact-checking": "You are FactBot, verifying claims and ensuring factual accuracy with cited reasoning.",
      "math-reasoning": "You are MathBot, solving mathematical problems and quantitative challenges step-by-step.",
      "image-analysis": "You are VisionBot, analyzing and describing visual content in detail.",
      planning: "You are PlannerBot, creating strategic, actionable plans and structured workflows.",
    };

    return `${personas[capability] || `You are ${agentName}, an AI specialist.`}

You are operating as an autonomous AI agent in the AgentForge economy on Arc blockchain.
Your work is evaluated on-chain and directly impacts your reputation score.
Be thorough, accurate, and professional. Deliver real value.`;
  }

  private log(task: Task, level: LogEntry["level"], message: string, data?: Record<string, unknown>): void {
    const entry: LogEntry = { timestamp: new Date().toISOString(), level, message, data };
    task.orchestrationLog.push(entry);
    console.log(`[${task.id.slice(0, 8)}] [${level.toUpperCase()}] ${message}`);
    this.emit(task, "log:entry", entry);
  }

  private emit(task: Task, type: string, payload: unknown): void {
    wsService.broadcast({
      type: type as any,
      taskId: task.id,
      payload,
      timestamp: new Date().toISOString(),
    });
  }
}

export const orchestrationEngine = new OrchestrationEngine();