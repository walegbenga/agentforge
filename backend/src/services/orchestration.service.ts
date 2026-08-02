import Groq from "groq-sdk";
import { randomUUID } from "crypto";
import { keccak256, toBytes } from "viem";
import { agentRegistry } from "./agentRegistry.service.js";
import { onChainService } from "./onchain.service.js";
import { wsService } from "./websocket.service.js";
import { taskStore } from "./taskStore.service.js";
import { parseFileDeliverable, runStructuralCheck } from "../utils/fileDeliverable.js";
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
    taskId?: string;
    // ✅ NEW: when the requester's own wallet already called createTask()
    // on the escrow contract (real USDC, real transaction, real fee),
    // the frontend passes the resulting on-chain task ID + tx hash here.
    onChainTaskId?: string;
    createTaskTxHash?: string;
  }): Promise<Task> {
    const taskId = params.taskId || randomUUID();

    const task: Task = {
      id: taskId,
      requesterAddress: params.requesterAddress.toLowerCase(),
      description: params.description,
      totalBudget: params.budget,
      allocatedBudget: 0,
      status: "decomposing",
      subtasks: [],
      orchestrationLog: [
        {
          timestamp: new Date().toISOString(),
          level: "info" as const,
          message: "Background worker started processing task",
        },
      ],
      txHashes: {},
      createdAt: new Date().toISOString(),
    };

    if (params.onChainTaskId && params.createTaskTxHash) {
      task.onChainTaskId = params.onChainTaskId;
      task.txHashes["createTask"] = params.createTaskTxHash;
      task.userFunded = true;
    }

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
    return await taskStore.getByAddress(address.toLowerCase());
  }

  async claimSubtask(taskId: string, subtaskIndex: number, walletAddress: string): Promise<Task> {
    const task = await taskStore.get(taskId);
    if (!task) throw new Error("Task not found");

    const subtask = task.subtasks.find((s) => s.subtaskIndex === subtaskIndex);
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

    // ✅ FIX: Claiming previously just parked the subtask at "assigned" and
    // stopped — nothing ever executed it, evaluated it, or re-checked
    // whether the task as a whole could now complete. A task with one
    // unclaimable subtask (no matching agent at assignment time) was a
    // permanent dead end: even a human manually claiming it here did
    // nothing, because this function never continued the pipeline.
    // Now claiming actually resumes orchestration for this task.
    task.status = "executing";
    this.emit(task, "task:updated", { status: "executing" });
    await taskStore.set(task);

    await this.processSubtask(task, subtask);
    await this.finalizeTask(task);

    return (await taskStore.get(taskId))!;
  }

  /**
   * Single source of truth for "is this task actually done." Called after
   * the initial orchestration run AND after any subtask is claimed and
   * resolved later — so a task can still reach "completed" even if one of
   * its subtasks started out unassigned and was claimed well after the
   * rest of the task had already settled or disputed.
   */
  private async finalizeTask(task: Task): Promise<void> {
    const allResolved = task.subtasks.every((s) => s.status === "settled" || s.status === "disputed");

    if (allResolved) {
      // ✅ FIX: this is the only call in the whole codebase that actually
      // triggers the contract's refund of unallocated budget (from disputed
      // subtasks, or any budget never assigned to a subtask at all) back to
      // the requester. Without it, that USDC just sits frozen in escrow
      // forever — completeTask() was never called anywhere before this.
      if (task.onChainTaskId) {
        try {
          const disputedCount = task.subtasks.filter((s) => s.status === "disputed").length;
          await onChainService.completeTask(task.onChainTaskId);
          if (disputedCount > 0) {
            this.log(task, "success", `On-chain: unallocated budget from ${disputedCount} disputed subtask(s) refunded to requester`);
          }
        } catch (chainErr) {
          // Contract auto-completes via settleSubtask() when every subtask
          // settles with zero disputes, so "already completed" here is
          // expected and not an error — only log anything else.
          const msg = (chainErr as Error).message;
          if (!msg.includes("Not active")) {
            this.log(task, "warning", `On-chain task completion failed: ${msg}`);
          }
        }
      }

      task.status = "completed";
      task.completedAt = new Date().toISOString();
      await taskStore.set(task);
      this.emit(task, "task:updated", {
        status: "completed",
        completedAt: task.completedAt,
      });
      const disputedCount = task.subtasks.filter((s) => s.status === "disputed").length;
      this.log(
        task,
        "success",
        disputedCount > 0
          ? `✓ Task completed — ${task.subtasks.length - disputedCount}/${task.subtasks.length} subtasks settled, ${disputedCount} disputed`
          : "✓ Task completed successfully"
      );
    } else {
      const stillPending = task.subtasks.filter((s) => s.status === "pending").length;
      task.status = "pending";
      await taskStore.set(task);
      this.log(
        task,
        "info",
        stillPending > 0
          ? `Task partially resolved. ${stillPending} subtask(s) still unclaimed — open for claiming.`
          : "Task partially resolved. Waiting on subtasks still in progress."
      );
      this.emit(task, "task:updated", { status: "pending" });
    }
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

    const hasAssigned = task.subtasks.some((s) => s.assignedAgent);
    const pendingCount = task.subtasks.filter((s) => s.status === "pending").length;

    if (!hasAssigned) {
      task.status = "pending";
      this.log(task, "warning", `All ${task.subtasks.length} subtasks are pending. Waiting for agents to claim.`);
      this.emit(task, "task:updated", { status: "pending" });
      await taskStore.set(task);
      return;
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

    await this.finalizeTask(task);
  }

  private async createOnChainTask(task: Task): Promise<void> {
    if (task.userFunded && task.onChainTaskId) {
      // The requester's own wallet already paid for this — verify it on
      // -chain rather than trusting the frontend's word for it, then move
      // on. No operator funds are spent here.
      this.log(task, "info", `Verifying user-funded task #${task.onChainTaskId} on-chain...`);
      try {
        const onChain = await onChainService.getOnChainTask(task.onChainTaskId);

        if (onChain.requester.toLowerCase() !== task.requesterAddress.toLowerCase()) {
          throw new Error("On-chain requester does not match task requester");
        }
        if (onChain.totalBudget !== BigInt(task.totalBudget)) {
          throw new Error(
            `On-chain budget (${onChain.totalBudget}) does not match submitted budget (${task.totalBudget})`
          );
        }
        if (onChain.status !== 0 /* TaskStatus.Active */) {
          throw new Error(`On-chain task is not active (status=${onChain.status})`);
        }

        this.log(task, "success", `✓ Verified: requester funded $${(task.totalBudget / 1_000_000).toFixed(2)} USDC in escrow (2% platform fee applies at settlement)`, {
          txHash: task.txHashes["createTask"],
        });
        return;
      } catch (err) {
        // A task that claims to be user-funded but fails verification is
        // rejected outright — we do NOT silently fall back to spending the
        // operator wallet for a task someone else may not have actually paid for.
        task.status = "failed";
        task.error = `On-chain verification failed: ${(err as Error).message}`;
        this.log(task, "error", task.error);
        throw err;
      }
    }

    // Fallback: no on-chain proof of payment was supplied (e.g. a caller
    // hitting the API directly rather than through the wallet-pay UI flow).
    // This subsidizes the task from the operator wallet — fine for a demo/
    // dev environment, but this is the "$5 never gets deducted" behavior
    // and should not be relied on in production.
    this.log(task, "warning", "No on-chain payment proof provided — funding from operator wallet (subsidized/demo mode)");
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
      "image-analysis", "planning", "app-builder",
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

PIPELINE GUIDANCE:
- If the task asks to build, create, or code an app/website/tool/script (i.e. it wants working software as the output), use this pipeline instead of a single subtask:
    1. "planning" — produce a concrete spec: features, tech stack, file structure
    2. "app-builder" — write the actual application: real, complete file contents (not snippets or pseudocode), following the spec
    3. "code-review" — review the app-builder's actual output for bugs, security issues, and missing pieces
  Do not use "code-review" as a substitute for "app-builder" — code-review's job is to critique existing code, not author a new application.
- If the task is research, writing, analysis, or anything that isn't "produce working software," use whichever single capability fits best — don't force the build pipeline onto non-coding tasks.

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
    const requesterAgent = await agentRegistry.getOrCreateAgent(task.requesterAddress);

    for (let i = 0; i < decomposition.subtasks.length; i++) {
      const sub = decomposition.subtasks[i];
      const budgetMicro = Math.floor(sub.estimatedBudget * 1_000_000);

      let agent = await agentRegistry.getBestAgent(sub.capability as AgentCapability);

      if (!agent && requesterAgent.capabilities.includes(sub.capability as AgentCapability)) {
        agent = requesterAgent;
        this.log(task, "info", `Requester ${requesterAgent.name} can handle subtask ${i + 1} (${sub.capability})`);
      }

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
    const readySubtasks = task.subtasks.filter((s) => s.assignedAgent);
    if (readySubtasks.length === 0) {
      this.log(task, "info", "No subtasks ready for execution");
      return;
    }
    await Promise.all(readySubtasks.map((s) => this.processSubtask(task, s)));
  }

  private static readonly MAX_RETRIES = 2;

  /**
   * Runs one subtask end-to-end: execute → evaluate → settle or dispute.
   * On dispute, automatically spawns a retry (preferring a different agent
   * than the one who failed) up to MAX_RETRIES, so one bad attempt doesn't
   * permanently sink a task when a fresh try might succeed.
   */
  private async processSubtask(task: Task, subtask: Subtask): Promise<void> {
    await this.executeSubtask(task, subtask);

    if (subtask.status === "disputed") {
      // Execution itself failed (e.g. the LLM call errored) before any
      // deliverable existed to evaluate — still retry-eligible.
      await this.maybeRetry(task, subtask);
      return;
    }
    if (subtask.status !== "submitted") return;

    const evaluation = await this.evaluateDeliverable(task, subtask);

    if (evaluation.approved) {
      try {
        const settleTx = await onChainService.settleSubtask(task.onChainTaskId!, subtask.subtaskIndex);
        task.txHashes[`settle-${subtask.subtaskIndex}`] = settleTx;
      } catch (chainErr) {
        this.log(task, "warning", `On-chain settlement failed for subtask ${subtask.subtaskIndex}: ${(chainErr as Error).message}`);
      }

      subtask.status = "settled";
      subtask.settledAt = new Date().toISOString();
      await agentRegistry.recordCompletion(subtask.assignedAgent!.id, subtask.budget);
      await taskStore.set(task);

      this.log(task, "success", `✓ ${subtask.assignedAgent!.name} settled — score ${evaluation.score}/100`, {
        payout: subtask.budget / 1_000_000,
      });
      this.emit(task, "subtask:settled", {
        subtaskIndex: subtask.subtaskIndex,
        agentName: subtask.assignedAgent!.name,
        score: evaluation.score,
        payout: subtask.budget,
        txHash: task.txHashes[`settle-${subtask.subtaskIndex}`],
      });
      return;
    }

    // Rejected — dispute on-chain (frees the reserved budget), persist why,
    // then decide whether a retry is warranted.
    try {
      await onChainService.disputeSubtask(task.onChainTaskId!, subtask.subtaskIndex);
    } catch (chainErr) {
      this.log(task, "warning", `On-chain dispute failed for subtask ${subtask.subtaskIndex}: ${(chainErr as Error).message}`);
    }

    subtask.status = "disputed";
    subtask.disputeReason = evaluation.feedback;
    task.allocatedBudget = Math.max(0, task.allocatedBudget - subtask.budget);
    await agentRegistry.recordDispute(subtask.assignedAgent!.id);
    await taskStore.set(task);

    this.log(task, "warning", `✗ ${subtask.assignedAgent!.name} disputed — ${evaluation.feedback}`);
    this.emit(task, "subtask:disputed", {
      subtaskIndex: subtask.subtaskIndex,
      reason: evaluation.feedback,
    });

    await this.maybeRetry(task, subtask);
  }

  private async maybeRetry(task: Task, subtask: Subtask): Promise<void> {
    const retryCount = subtask.retryCount ?? 0;
    if (retryCount >= OrchestrationEngine.MAX_RETRIES) {
      this.log(task, "info", `Subtask ${subtask.subtaskIndex} exhausted retries (${OrchestrationEngine.MAX_RETRIES}) — leaving as disputed.`);
      return;
    }

    const retry = await this.spawnRetry(task, subtask);
    if (retry) {
      await this.processSubtask(task, retry);
    } else {
      this.log(task, "warning", `No agent available to retry subtask ${subtask.subtaskIndex} (${subtask.capability}) — leaving as disputed.`);
    }
  }

  /**
   * Creates a new subtask attempt for a disputed one, preferring an agent
   * OTHER than the one who just failed (falls back to the same agent only
   * if no alternate exists). Reuses the budget freed by the dispute — the
   * on-chain allocatedBudget was decremented by disputeSubtask(), so
   * re-reserving the same amount for the retry stays within totalBudget.
   */
  private async spawnRetry(task: Task, original: Subtask): Promise<Subtask | null> {
    const failedAgentId = original.assignedAgent?.id;
    let agent = failedAgentId ? await agentRegistry.getBestAgent(original.capability, failedAgentId) : null;
    if (!agent) agent = original.assignedAgent ?? await agentRegistry.getBestAgent(original.capability);
    if (!agent) return null;

    const newIndex = Math.max(...task.subtasks.map((s) => s.subtaskIndex)) + 1;
    const retryCount = (original.retryCount ?? 0) + 1;

    const retrySubtask: Subtask = {
      id: randomUUID(),
      taskId: task.id,
      subtaskIndex: newIndex,
      description: `${original.description} [retry ${retryCount}/${OrchestrationEngine.MAX_RETRIES} — previous attempt disputed]`,
      capability: original.capability,
      assignedAgent: agent,
      budget: original.budget,
      status: "assigned",
      assignedAt: new Date().toISOString(),
      retryOf: original.subtaskIndex,
      retryCount,
    };

    task.subtasks.push(retrySubtask);
    task.allocatedBudget += retrySubtask.budget;
    await taskStore.set(task);

    this.log(task, "info", `Retrying subtask ${original.subtaskIndex} with ${agent.name} (attempt ${retryCount + 1}/${OrchestrationEngine.MAX_RETRIES + 1})`);

    try {
      const txHash = await onChainService.assignSubtask({
        taskId: task.onChainTaskId!,
        agentWallet: agent.walletAddress as `0x${string}`,
        capability: original.capability,
        budget: retrySubtask.budget,
        description: retrySubtask.description,
      });
      retrySubtask.onChainSubtaskIndex = newIndex;
      task.txHashes[`assign-${newIndex}`] = txHash;
      await taskStore.set(task);
    } catch (chainErr) {
      this.log(task, "warning", `On-chain assignment failed for retry subtask ${newIndex}: ${(chainErr as Error).message}`);
    }

    this.emit(task, "subtask:assigned", {
      subtaskIndex: newIndex,
      agentName: agent.name,
      capability: original.capability,
      budget: retrySubtask.budget,
      status: "assigned",
    });

    return retrySubtask;
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
        max_tokens: subtask.capability === "app-builder" ? 8000 : 4000,
        temperature: 0.5,
        messages: [
          {
            role: "system",
            content: `${this.buildAgentSystemPrompt(agent.name, subtask.capability)}

IMPORTANT FORMATTING RULES:
- You MUST output your deliverable using Markdown formatting.
- Use # for main titles, ## for subtitles, and bullet points for lists.
- If you are writing code, you MUST wrap it in code blocks with the language specified (e.g., \`\`\`javascript ... \`\`\` or \`\`\`solidity ... \`\`\`).
- Do not just output a wall of text. Structure it professionally.${subtask.capability === "app-builder" ? `

APP-BUILDER OUTPUT FORMAT (required — this output is parsed programmatically):
- Output the COMPLETE contents of every file needed to run the app. No placeholders, no "// rest of the code here", no truncation.
- For EACH file, use exactly this format — a heading line, then a fenced code block with the language:

### FILE: relative/path/to/file.ext
\`\`\`language
<complete file contents>
\`\`\`

- Include every file needed: source files, package.json/requirements.txt, a README.md with setup + run instructions, and config files. A "working app" means someone can follow the README and actually run it.
- Do not add commentary between files beyond the "### FILE:" heading — keep narrative explanation to a short intro before the first file.` : ""}`,
          },
          {
            role: "user",
            content: `TASK CONTEXT: ${task.description}\n\nYOUR SUBTASK: ${subtask.description}\n\nDeliver your work now. Be thorough, specific, and professionally formatted.`,
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

      // ⚠️ FIX: on-chain settlement (which pays the agent) used to happen
      // right here, immediately on submission — before evaluateAndSettle()
      // ever ran. That meant a subtask judged "disputed" moments later had
      // already been paid out in full on-chain; the dispute was cosmetic.
      // Payment now only happens in evaluateAndSettle(), after the
      // deliverable is actually judged.

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
      task.allocatedBudget = Math.max(0, task.allocatedBudget - subtask.budget);
      await taskStore.set(task);
      this.log(task, "error", `${agent.name} failed: ${(err as Error).message}`);

      try {
        await onChainService.disputeSubtask(task.onChainTaskId!, subtask.subtaskIndex);
      } catch (chainErr) {
        this.log(task, "warning", `Could not free on-chain budget for failed subtask ${subtask.subtaskIndex}: ${(chainErr as Error).message}`);
      }
    }
  }

  private async evaluateDeliverable(task: Task, subtask: Subtask): Promise<EvaluationResult> {
    if (subtask.capability === "app-builder") {
      return this.evaluateAppBuilderDeliverable(task, subtask);
    }

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      temperature: 0.1,
      messages: [
        {
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
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    return { ...result, deliverableHash: subtask.deliverableHash! };
  }

  /**
   * Stricter, "does this look like a working app" evaluation for
   * app-builder subtasks. Two stages:
   *   1. Deterministic structural check (regex-based, no LLM) — catches
   *      obvious failures (stub code, no dependency manifest) consistently
   *      and cheaply, before spending a model call.
   *   2. If structure passes, an LLM rubric specific to app completeness
   *      — not the generic "quality and relevance" prompt used elsewhere,
   *      which has no concept of "does this actually run."
   */
  private async evaluateAppBuilderDeliverable(task: Task, subtask: Subtask): Promise<EvaluationResult> {
    const parsed = parseFileDeliverable(subtask.deliverable || "");

    if (!parsed) {
      return {
        approved: false,
        score: 0,
        feedback: "Did not follow the required '### FILE: path' output format — no parseable files were produced.",
        deliverableHash: subtask.deliverableHash!,
      };
    }

    const structural = runStructuralCheck(parsed);
    if (!structural.passed) {
      return {
        approved: false,
        score: 20,
        feedback: `Failed structural check: ${structural.issues.join("; ")}`,
        deliverableHash: subtask.deliverableHash!,
      };
    }

    const fileManifest = parsed.files.map((f) => `- ${f.path} (${f.content.split("\n").length} lines)`).join("\n");

    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 500,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: `You are judging whether this is a genuinely complete, working application — not just plausible-looking code.

ORIGINAL TASK: ${task.description}
SUBTASK: ${subtask.description}

FILES SUBMITTED:
${fileManifest}
${structural.hasReadme ? "" : "\n(No README was found — note this as a gap.)"}

RUBRIC — check specifically for:
1. Do the files actually implement the requested features, or just scaffold/boilerplate with no real logic?
2. Are file references consistent — does the manifest's entry point match an actual file, do imports point at files that exist in the submission?
3. Is there any code that looks unfinished (dead-end functions, logic that doesn't connect, obviously wrong syntax)?
4. Would a developer following the README (if present) actually be able to run this?

Be genuinely strict — approve only if this would actually run and do what was asked, not if it merely "looks like" an app.

FULL SUBMISSION:
${subtask.deliverable}

Return ONLY valid JSON (no markdown):
{
  "approved": <true/false>,
  "score": <0-100>,
  "feedback": "<brief, specific evaluation — cite a file if something is wrong>"
}`,
        },
      ],
    });

    const text = response.choices[0]?.message?.content ?? "";
    const clean = text.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);

    // A missing README doesn't hard-fail structurally, but it should never
    // be silently approved either — cap the score and note it regardless
    // of what the model decided on its own.
    if (!structural.hasReadme && result.approved && result.score > 70) {
      result.score = 70;
      result.feedback = `${result.feedback} (Capped: no README with setup instructions.)`;
    }

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
      "app-builder": "You are BuilderBot, a full-stack engineer who builds complete, working applications from an idea or spec — real file structure, real working code, ready to run.",
    };

    return `${personas[capability] || `You are ${agentName}, an AI specialist.`}

You are operating as an autonomous AI agent in the ForgeOps AI economy on Arc blockchain.
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