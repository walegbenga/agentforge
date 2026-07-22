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
} from "../types/index.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

export class OrchestrationEngine {

  async createAndRunTask(params: {
    description: string;
    budget: number;
    requesterAddress: string;
  }): Promise<Task> {
    const taskId = randomUUID();

    const task: Task = {
      id: taskId,
      requesterAddress: params.requesterAddress,
      description: params.description,
      totalBudget: params.budget,
      allocatedBudget: 0,
      status: "pending",
      subtasks: [],
      orchestrationLog: [],
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
    return await taskStore.getByAddress(address);
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

    task.status = "executing";
    this.emit(task, "task:updated", { status: "executing" });
    await taskStore.set(task);

    await this.executeSubtasks(task);

    task.status = "evaluating";
    this.emit(task, "task:updated", { status: "evaluating" });
    await taskStore.set(task);

    await this.evaluateAndSettle(task);

    task.status = "completed";
    task.completedAt = new Date().toISOString();
    await taskStore.set(task);

    this.emit(task, "task:updated", {
      status: "completed",
      completedAt: task.completedAt,
    });
    this.log(task, "success", "✓ Task completed successfully");
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
${JSON.stringify(availableAgents, null, 2)}

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
    for (let i = 0; i < decomposition.subtasks.length; i++) {
      const sub = decomposition.subtasks[i];
      const budgetMicro = Math.floor(sub.estimatedBudget * 1_000_000);
      const agent = await agentRegistry.getBestAgent(sub.capability as AgentCapability);

      if (!agent) {
        this.log(task, "warning", `No agent for capability: ${sub.capability}`);
        continue;
      }

      const subtask: Subtask = {
        id: randomUUID(),
        taskId: task.id,
        subtaskIndex: i,
        description: sub.description,
        capability: sub.capability as AgentCapability,
        assignedAgent: agent,
        budget: budgetMicro,
        status: "assigned",
        assignedAt: new Date().toISOString(),
      };

      task.subtasks.push(subtask);
      task.allocatedBudget += budgetMicro;

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

      await taskStore.set(task);
      this.log(task, "info", `Subtask ${i + 1} → ${agent.name} (${sub.capability})`, {
        budget: sub.estimatedBudget,
        agent: agent.name,
      });
      this.emit(task, "subtask:assigned", {
        subtaskIndex: i,
        agentName: agent.name,
        capability: sub.capability,
        budget: budgetMicro,
      });
    }
  }

  private async executeSubtasks(task: Task): Promise<void> {
    await Promise.all(task.subtasks.map((s) => this.executeSubtask(task, s)));
  }

  private async executeSubtask(task: Task, subtask: Subtask): Promise<void> {
    const agent = subtask.assignedAgent!;
    subtask.status = "executing";
    await taskStore.set(task);

    this.emit(task, "subtask:executing", {
      subtaskIndex: subtask.subtaskIndex,
      agentName: agent.name,
    });
    this.emit(task, "agent:thinking", {
      agent: agent.name,
      message: `Processing: ${subtask.description}`,
    });

    try {
      const response = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        max_tokens: 2000,
        temperature: 0.5,
        messages: [
          { role: "system", content: this.buildAgentSystemPrompt(agent.name, subtask.capability) },
          {
            role: "user",
            content: `TASK CONTEXT: ${task.description}\n\nYOUR SUBTASK: ${subtask.description}\n\nDeliver your work now. Be thorough and specific.`,
          },
        ],
      });

      const deliverable = response.choices[0]?.message?.content ?? "";
      const deliverableHash = keccak256(toBytes(deliverable));

      subtask.deliverable = deliverable;
      subtask.deliverableHash = deliverableHash;
      subtask.status = "submitted";
      subtask.submittedAt = new Date().toISOString();
      await taskStore.set(task);

      try {
        await onChainService.settleSubtask(task.onChainTaskId!, subtask.subtaskIndex);
        task.txHashes[`settle-${subtask.subtaskIndex}`] = deliverableHash;
        await taskStore.set(task);
      } catch {}

      this.log(task, "info", `${agent.name} submitted deliverable`, {
        hash: deliverableHash,
        preview: deliverable.slice(0, 100) + "...",
      });
      this.emit(task, "subtask:submitted", {
        subtaskIndex: subtask.subtaskIndex,
        agentName: agent.name,
        deliverableHash,
        preview: deliverable.slice(0, 150),
      });
    } catch (err) {
      subtask.status = "disputed";
      subtask.error = (err as Error).message;
      await taskStore.set(task);
      this.log(task, "error", `${agent.name} failed: ${(err as Error).message}`);
    }
  }

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