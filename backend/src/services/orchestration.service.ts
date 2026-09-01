import Groq from "groq-sdk";
import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from "groq-sdk/resources/chat/completions";
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

// Cost-tiered model routing. openai/gpt-oss-120b (~$0.15/$0.60 per M
// input/output tokens) is reserved for calls where getting it wrong is
// expensive — actually generating code, and judging whether generated
// code is real and complete. openai/gpt-oss-20b (~$0.075/$0.30, roughly
// 2x cheaper) handles structured, lower-stakes calls: decomposition
// (follows a JSON schema), generic non-code evaluation, and the
// integration yes/no check. This exists because the platform's real cost
// is these LLM calls, not a percentage of task budgets — see the service
// fee added to OrchestratorEscrow.sol for the other half of that fix.
//
// ⚠️ 2026-08: the original models used here (llama-3.3-70b-versatile,
// llama-3.1-8b-instant) were deprecated by Groq on 2026-06-17 — that's
// what a "model_not_found" 404 from Groq means if you see one again.
// These are Groq's own recommended replacements as of this fix; check
// https://console.groq.com/docs/models for current availability before
// assuming these two are still correct months from now — Groq's lineup
// changes faster than most providers, and this is the second time in
// this project's life the model IDs have gone stale under it.
const STRONG_MODEL = "openai/gpt-oss-120b";
const CHEAP_MODEL = "openai/gpt-oss-20b";

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

    // ✅ FIX: this used to be fire-and-forget (`.catch()` on a detached
    // promise, never awaited) — meaning createAndRunTask returned almost
    // instantly after just STARTING orchestration, not after it actually
    // finished. That meant the BullMQ job wrapping this call also
    // "completed" almost instantly regardless of how long the real
    // decompose→build→evaluate pipeline took — so the Worker's
    // concurrency setting was never actually gating how many full
    // orchestrations ran at once. Every submitted task's real work ran
    // fully unbounded in the background, all hammering Groq concurrently
    // with no ceiling. Now this genuinely awaits the whole pipeline, so
    // the queue's concurrency limit (see taskQueue.service.ts) is real
    // backpressure, not just a limit on how fast job records get created.
    try {
      await this.runOrchestration(task);
    } catch (err: any) {
      task.status = "failed";
      task.error = err.message;
      this.log(task, "error", `Orchestration failed: ${err.message}`);
      this.emit(task, "task:updated", { status: "failed", error: err.message });
      await taskStore.set(task).catch(console.error);
      await this.refundOnFailure(task);
    }

    return task;
  }

  async getTask(taskId: string): Promise<Task | undefined> {
    return await taskStore.get(taskId);
  }

  async getAllTasks(opts?: { limit?: number; cursor?: string }): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    return await taskStore.getAll(opts);
  }

  async getTasksByAddress(address: string, opts?: { limit?: number; cursor?: string }): Promise<{ tasks: Task[]; nextCursor: string | null }> {
    return await taskStore.getByAddress(address.toLowerCase(), opts);
  }

  async getStatsAggregate() {
    return await taskStore.getStatsAggregate();
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
  /**
   * A failure anywhere in the pipeline (LLM provider out of quota, network
   * error, anything) previously left escrowed USDC permanently stuck —
   * nothing ever called completeTask() unless execution reached the normal
   * end of the happy path. This is the fallback: attempt a refund
   * regardless of where or why it failed. completeTask() correctly
   * refunds the FULL budget if zero subtasks were ever allocated (e.g. a
   * decomposition-time failure), or whatever's left over otherwise.
   */
  private async refundOnFailure(task: Task): Promise<void> {
    if (!task.onChainTaskId) return;
    try {
      await onChainService.completeTask(task.onChainTaskId);
      this.log(task, "success", "On-chain: escrowed budget refunded to requester after failure");
    } catch (chainErr) {
      this.log(task, "error", `Could not auto-refund after failure: ${(chainErr as Error).message}. Manual intervention needed for on-chain task ${task.onChainTaskId}.`);
    }
    await taskStore.set(task).catch(console.error);
  }

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
    1. "planning" — produce a concrete spec: full feature set, tech stack, file structure
    2. "app-builder" — write the actual application: real, complete file contents (not snippets or pseudocode), following the spec
    3. "code-review" — review the app-builder's actual output for bugs, security issues, and missing pieces
  Do not use "code-review" as a substitute for "app-builder" — code-review's job is to critique existing code, not author a new application.
- A single app-builder subtask has a limited output budget — enough for a handful of files, not an entire multi-feature product. If the planned feature set is more than a simple single-screen tool (e.g. a banking app with auth + transfers + bills + savings, not just a to-do list), split the build into 2-4 SEPARATE app-builder subtasks, one per feature module (e.g. "Core & Auth", "Transfers & Payments", "Savings & Bill Pay"). Each module subtask gets its own full output budget, and they run in sequence, each building on what the previous one produced — so scope each one to what's realistically buildable as a coherent chunk, not the whole app at once. For a genuinely simple single-purpose tool, one app-builder subtask is correct — don't split trivial tasks needlessly.
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

    const response = await this.callGroqWithRateLimitRetry({
      model: CHEAP_MODEL,
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
        dependsOn: sub.dependsOn,
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

    // ✅ FIX: don't trust the LLM's own dependsOn output to correctly wire
    // up the build pipeline — enforce the known relationship directly.
    // Without this, app-builder never saw planning's actual spec and
    // code-review never saw app-builder's actual code; each subtask only
    // ever received the original one-line task description, so "code
    // review" was really just guessing in the dark, and app-builder had no
    // real spec to build a comprehensive feature set from.
    const planningIdx = task.subtasks.find((s) => s.capability === "planning")?.subtaskIndex;
    const builderIdxs = task.subtasks
      .filter((s) => s.capability === "app-builder")
      .map((s) => s.subtaskIndex)
      .sort((a, b) => a - b);
    const reviewIdx = task.subtasks.find((s) => s.capability === "code-review")?.subtaskIndex;

    // Multiple app-builder subtasks = multiple feature modules. Chain them
    // sequentially (each depends on planning AND the previous module), not
    // parallel — module 2 needs to actually see what module 1 built to
    // extend it coherently (shared nav/config/App entry point) instead of
    // both independently inventing an incompatible project structure.
    builderIdxs.forEach((idx, i) => {
      const s = task.subtasks.find((s) => s.subtaskIndex === idx)!;
      const deps = new Set(s.dependsOn || []);
      if (planningIdx !== undefined) deps.add(planningIdx);
      if (i > 0) deps.add(builderIdxs[i - 1]);
      s.dependsOn = [...deps];
    });

    if (reviewIdx !== undefined && builderIdxs.length > 0) {
      const reviewSubtask = task.subtasks.find((s) => s.subtaskIndex === reviewIdx)!;
      reviewSubtask.dependsOn = [...new Set([...(reviewSubtask.dependsOn || []), ...builderIdxs])];
    }
    await taskStore.set(task);
  }

  private async executeSubtasks(task: Task): Promise<void> {
    const readySubtasks = task.subtasks.filter((s) => s.assignedAgent);
    if (readySubtasks.length === 0) {
      this.log(task, "info", "No subtasks ready for execution");
      return;
    }

    // ✅ FIX: previously every ready subtask fired in one Promise.all with
    // no ordering — app-builder could start before planning had produced
    // anything, code-review could start before app-builder had written a
    // line of code. Now: run in dependency-respecting waves. A subtask
    // only executes once everything in its dependsOn has resolved
    // (settled or disputed), so app-builder actually waits for planning's
    // real spec and code-review actually waits for app-builder's real code.
    const remaining = new Set(readySubtasks.map((s) => s.subtaskIndex));
    const isResolved = (idx: number) => {
      const s = task.subtasks.find((s) => s.subtaskIndex === idx);
      return !s || s.status === "settled" || s.status === "disputed";
    };

    while (remaining.size > 0) {
      const wave = readySubtasks.filter(
        (s) => remaining.has(s.subtaskIndex) && (s.dependsOn || []).every((d) => isResolved(d))
      );

      if (wave.length === 0) {
        // Dependency deadlock (e.g. the dependency is stuck pending with
        // no agent available) — run whatever's left rather than hang
        // forever; it just won't have its dependency's context available.
        const stuck = readySubtasks.filter((s) => remaining.has(s.subtaskIndex));
        this.log(task, "warning", `${stuck.length} subtask(s) still waiting on an unresolved dependency — running anyway without that context.`);
        await Promise.all(stuck.map((s) => { remaining.delete(s.subtaskIndex); return this.processSubtask(task, s); }));
        break;
      }

      wave.forEach((s) => remaining.delete(s.subtaskIndex));
      await Promise.all(wave.map((s) => this.processSubtask(task, s)));
    }
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

    let evaluation: EvaluationResult;
    try {
      evaluation = await this.evaluateDeliverable(task, subtask);
    } catch (err) {
      // ✅ FIX: this call was completely unguarded — an LLM provider error
      // here (rate limit, quota exhausted, outage) used to propagate all
      // the way up uncaught. For the top-level task creation path that at
      // least got caught and marked "failed" (now also refunded — see
      // refundOnFailure). But for a single subtask mid-task, the correct
      // response isn't "abort and refund the whole task" — sibling
      // subtasks may still be legitimately in progress. Treat it exactly
      // like an execution failure: dispute this one subtask, free its
      // budget, let it retry.
      subtask.status = "disputed";
      subtask.disputeReason = `Evaluation failed: ${(err as Error).message}`;
      task.allocatedBudget = Math.max(0, task.allocatedBudget - subtask.budget);
      await taskStore.set(task);
      this.log(task, "error", `Evaluation failed for subtask ${subtask.subtaskIndex}: ${(err as Error).message}`);

      try {
        await onChainService.disputeSubtask(task.onChainTaskId!, subtask.onChainSubtaskIndex ?? subtask.subtaskIndex);
      } catch (chainErr) {
        this.log(task, "warning", `Could not free on-chain budget after evaluation failure: ${(chainErr as Error).message}`);
      }

      await this.maybeRetry(task, subtask);
      return;
    }

    // ✅ Partial settlement: payout is proportional to the evaluator's
    // score, not a binary all-or-nothing. Below MIN_PAYABLE_SCORE, the
    // work doesn't earn any credit at all — full dispute, budget freed,
    // retry-eligible (same as before). At or above it, the agent gets
    // paid for the fraction of the job actually delivered, even if it
    // wasn't 100%.
    const MIN_PAYABLE_SCORE = 25;

    if (evaluation.score >= MIN_PAYABLE_SCORE) {
      const completionBps = Math.max(1, Math.min(10000, Math.round(evaluation.score * 100)));
      const payoutAmount = Math.floor((subtask.budget * completionBps) / 10000);
      const isPartial = completionBps < 10000;

      try {
        const settleTx = await onChainService.settleSubtask(
          task.onChainTaskId!,
          subtask.onChainSubtaskIndex ?? subtask.subtaskIndex,
          completionBps
        );
        task.txHashes[`settle-${subtask.subtaskIndex}`] = settleTx;
      } catch (chainErr) {
        this.log(task, "warning", `On-chain settlement failed for subtask ${subtask.subtaskIndex}: ${(chainErr as Error).message}`);
      }

      subtask.status = "settled";
      subtask.settledAt = new Date().toISOString();
      subtask.completionBps = completionBps;
      subtask.payoutAmount = payoutAmount;
      if (isPartial) {
        // Unpaid remainder frees back to unallocated, same as a dispute —
        // it gets refunded to the requester when the task completes.
        task.allocatedBudget = Math.max(0, task.allocatedBudget - (subtask.budget - payoutAmount));
      }
      await agentRegistry.recordCompletion(subtask.assignedAgent!.id, payoutAmount);
      await taskStore.set(task);

      this.log(
        task,
        "success",
        isPartial
          ? `◐ ${subtask.assignedAgent!.name} partially settled — ${evaluation.score}/100, paid $${(payoutAmount / 1_000_000).toFixed(2)} of $${(subtask.budget / 1_000_000).toFixed(2)}`
          : `✓ ${subtask.assignedAgent!.name} settled — score ${evaluation.score}/100`,
        { payout: payoutAmount / 1_000_000 }
      );
      this.emit(task, "subtask:settled", {
        subtaskIndex: subtask.subtaskIndex,
        agentName: subtask.assignedAgent!.name,
        score: evaluation.score,
        payout: payoutAmount,
        completionBps,
        partial: isPartial,
        txHash: task.txHashes[`settle-${subtask.subtaskIndex}`],
      });

      // ✅ FIX: code-review's findings used to be purely advisory — nothing
      // ever read its verdict or acted on it. If it flagged real
      // integration problems between modules, this now actually spawns a
      // targeted repair pass instead of just letting the report sit there.
      if (subtask.capability === "code-review") {
        await this.handlePostReviewIntegrationCheck(task, subtask);
      }

      // A partial settlement still reflects a real gap — worth one retry
      // attempt to see if a fresh pass can close it, same cap as a full
      // dispute. A perfect/near-perfect score skips this entirely.
      if (isPartial && evaluation.score < 85) {
        await this.maybeRetry(task, subtask);
      }
      return;
    }

    // Below the payable floor — dispute on-chain (frees the reserved
    // budget), persist why, then decide whether a retry is warranted.
    try {
      await onChainService.disputeSubtask(task.onChainTaskId!, subtask.onChainSubtaskIndex ?? subtask.subtaskIndex);
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
  /**
   * Runs after a code-review subtask settles. Its findings were previously
   * purely advisory — this asks a small, structured question of the review
   * itself: did it identify real integration problems between modules
   * (not just general code quality notes)? If so, and if there's budget
   * left, spawns one targeted repair pass with full context of every
   * module's real code plus the review's specific findings. Capped at one
   * repair attempt — no re-review loop — to keep this bounded.
   */
  private async handlePostReviewIntegrationCheck(task: Task, reviewSubtask: Subtask): Promise<void> {
    if (!reviewSubtask.deliverable) return;

    let verdict: { hasIntegrationIssues: boolean; summary: string };
    try {
      const response = await this.callGroqWithRateLimitRetry({
        model: CHEAP_MODEL,
        max_tokens: 300,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: `This is a code review of a multi-module app build:\n\n${reviewSubtask.deliverable}\n\nDoes this review identify any REAL integration/compatibility problems BETWEEN MODULES that would stop the app from actually running together (e.g. conflicting entry points, duplicate/incompatible navigation setups, mismatched imports between files from different modules)? General code-quality notes, style suggestions, or issues within a single file do NOT count — only cross-module integration breakage.\n\nReturn ONLY valid JSON (no markdown):\n{"hasIntegrationIssues": <true/false>, "summary": "<concise, specific description of exactly what needs fixing, or empty string if none>"}`,
          },
        ],
      });
      const text = response.choices[0]?.message?.content ?? "";
      verdict = JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch (err) {
      this.log(task, "warning", `Could not run post-review integration check: ${(err as Error).message}`);
      return;
    }

    if (!verdict.hasIntegrationIssues) return;

    const remainingBudget = task.totalBudget - task.allocatedBudget;
    const MIN_REPAIR_BUDGET = 500_000; // 0.5 USDC — below this, not worth attempting
    if (remainingBudget < MIN_REPAIR_BUDGET) {
      this.log(task, "warning", `Code review flagged integration issues but no budget remains for a repair pass: ${verdict.summary}`);
      return;
    }

    const builderSubtasks = task.subtasks.filter((s) => s.capability === "app-builder" && s.status === "settled");
    if (builderSubtasks.length === 0) return;

    const agent = await agentRegistry.getBestAgent("app-builder");
    if (!agent) {
      this.log(task, "warning", `Code review flagged integration issues but no app-builder agent is available to fix them: ${verdict.summary}`);
      return;
    }

    const newIndex = Math.max(...task.subtasks.map((s) => s.subtaskIndex)) + 1;
    const repairBudget = Math.min(remainingBudget, builderSubtasks[builderSubtasks.length - 1].budget);

    const repairSubtask: Subtask = {
      id: randomUUID(),
      taskId: task.id,
      subtaskIndex: newIndex,
      description: `Fix integration issues found in code review: ${verdict.summary}`,
      capability: "app-builder",
      assignedAgent: agent,
      budget: repairBudget,
      status: "assigned",
      assignedAt: new Date().toISOString(),
      dependsOn: [...builderSubtasks.map((s) => s.subtaskIndex), reviewSubtask.subtaskIndex],
    };

    task.subtasks.push(repairSubtask);
    task.allocatedBudget += repairBudget;
    await taskStore.set(task);

    this.log(task, "info", `Code review flagged integration issues — spawning a repair pass with ${agent.name}: ${verdict.summary}`);
    this.emit(task, "subtask:assigned", {
      subtaskIndex: newIndex,
      agentName: agent.name,
      capability: "app-builder",
      budget: repairBudget,
      status: "assigned",
    });

    try {
      const onChainIndex = task.subtasks.filter((s) => s.onChainSubtaskIndex !== undefined).length;
      const txHash = await onChainService.assignSubtask({
        taskId: task.onChainTaskId!,
        agentWallet: agent.walletAddress as `0x${string}`,
        capability: "app-builder",
        budget: repairBudget,
        description: repairSubtask.description,
      });
      repairSubtask.onChainSubtaskIndex = onChainIndex;
      task.txHashes[`assign-${newIndex}`] = txHash;
      await taskStore.set(task);
    } catch (chainErr) {
      this.log(task, "warning", `On-chain assignment failed for repair subtask ${newIndex}: ${(chainErr as Error).message}`);
    }

    await this.processSubtask(task, repairSubtask);
  }

  private async spawnRetry(task: Task, original: Subtask): Promise<Subtask | null> {
    const failedAgentId = original.assignedAgent?.id;
    let agent = failedAgentId ? await agentRegistry.getBestAgent(original.capability, failedAgentId) : null;
    if (!agent) agent = original.assignedAgent ?? await agentRegistry.getBestAgent(original.capability);
    if (!agent) return null;

    const retryCount = (original.retryCount ?? 0) + 1;

    // Deterministic, collision-free index — NOT Math.max(...task.subtasks)+1.
    // Multiple subtasks can dispute and retry concurrently (executeSubtasks
    // runs them in parallel), so two retries firing near-simultaneously
    // could both read the same max before either had pushed, computing the
    // same "next" index. This scheme only depends on values already fixed
    // at this point (the original's own index, which never changes, and
    // this retry's own count), so no two retries can ever collide.
    const newIndex = (original.retryOf ?? original.subtaskIndex) * 1000 + retryCount;

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
      dependsOn: original.dependsOn,
    };

    task.subtasks.push(retrySubtask);
    task.allocatedBudget += retrySubtask.budget;
    await taskStore.set(task);

    this.log(task, "info", `Retrying subtask ${original.subtaskIndex} with ${agent.name} (attempt ${retryCount + 1}/${OrchestrationEngine.MAX_RETRIES + 1})`);

    try {
      // The contract auto-increments its own internal subtaskCount on every
      // assignSubtask() call — it does NOT take an index parameter. So the
      // on-chain index is whatever the contract's running count is, which
      // is NOT the same as our off-chain newIndex (that's a deliberately
      // collision-free bookkeeping scheme, unrelated to the contract's
      // sequential counter). Track it as "how many subtasks for this task
      // have already been successfully assigned on-chain."
      const onChainIndex = task.subtasks.filter((s) => s.onChainSubtaskIndex !== undefined).length;

      const txHash = await onChainService.assignSubtask({
        taskId: task.onChainTaskId!,
        agentWallet: agent.walletAddress as `0x${string}`,
        capability: original.capability,
        budget: retrySubtask.budget,
        description: retrySubtask.description,
      });
      retrySubtask.onChainSubtaskIndex = onChainIndex;
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

  /**
   * Wraps a Groq call with rate-limit-aware retry. A 429 is Groq's
   * capacity, not a verdict on the agent's work — it should never dispute
   * the subtask or consume one of its (precious, capped) quality retries.
   * Waits for whatever Groq actually tells us to wait (parsed from the
   * error message), with jitter so concurrent subtasks hitting the same
   * limit don't all wake up and collide again at the same instant.
   *
   * Distinct from a 413 ("request too large for model ... TPM"), which
   * means a SINGLE request already exceeds the account's entire per-
   * minute ceiling on its own — no amount of waiting fixes that, so
   * retrying it is pure wasted time. That one fails immediately with a
   * clear message instead of silently behaving like a normal rate limit.
   */
  private async callGroqWithRateLimitRetry(
    params: ChatCompletionCreateParamsNonStreaming,
    maxAttempts = 4
  ): Promise<ChatCompletion> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await groq.chat.completions.create(params);
      } catch (err: any) {
        const isOversizedRequest = err?.status === 413;
        if (isOversizedRequest) {
          throw new Error(
            `Request too large for this model's per-minute token limit (not a transient rate limit — retrying won't help). Reduce max_tokens or prompt size. Original: ${err?.message || err}`
          );
        }

        const isRateLimit =
          err?.status === 429 ||
          err?.error?.code === "rate_limit_exceeded" ||
          /rate_limit_exceeded/i.test(err?.message || "");

        if (!isRateLimit || attempt === maxAttempts) throw err;

        const match = /try again in ([\d.]+)s/i.exec(err?.message || "");
        const suggestedWaitMs = match ? parseFloat(match[1]) * 1000 : 15_000;
        const jitterMs = Math.random() * 2000;
        const waitMs = suggestedWaitMs + jitterMs;

        console.warn(`Groq rate limit hit (attempt ${attempt}/${maxAttempts}) — waiting ${(waitMs / 1000).toFixed(1)}s before retrying`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    throw new Error("Unreachable"); // maxAttempts >= 1 guarantees return or throw above
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
      const resolveLatestAttempt = (idx: number): Subtask | undefined => {
        let current = task.subtasks.find((s) => s.subtaskIndex === idx);
        // Walk forward through retries to find the final attempt for this
        // line of work — code-review should see the code that actually
        // settled, not a rejected first draft that got retried.
        while (current?.status === "disputed") {
          const retry = task.subtasks.find((s) => s.retryOf === current!.subtaskIndex);
          if (!retry) break;
          current = retry;
        }
        return current;
      };

      // ⚠️ This account's TPM ceiling (checked live via 413 errors from
      // Groq) is tight enough that dependency context — full prior module
      // code, embedded unconditionally — was alone enough to blow the
      // limit before a single output token was even requested. Cap it to
      // a fixed total budget, split fairly across however many
      // dependencies exist, rather than growing unboundedly with more
      // modules or a code-review that depends on several of them.
      // Budget shape differs by capability: app-builder needs a LARGE
      // output (the code itself) so input must stay small, or the total
      // blows the TPM ceiling. code-review needs the OPPOSITE — its own
      // output is just a short prose review (max_tokens: 2000), so it can
      // afford a much bigger input budget to actually see the code it's
      // reviewing. The earlier flat 3000-char budget starved code-review
      // down to almost nothing when it had multiple app-builder modules
      // to review, which is why it was legitimately reporting "the source
      // files are missing" — it wasn't wrong, it just wasn't given enough.
      const TOTAL_CONTEXT_BUDGET_CHARS = subtask.capability === "code-review" ? 12000 : 3000;
      const resolvedDeps = (subtask.dependsOn || [])
        .map((idx) => resolveLatestAttempt(idx))
        .filter((s): s is Subtask => !!s && !!s.deliverable);
      const perDepBudget = resolvedDeps.length > 0 ? Math.floor(TOTAL_CONTEXT_BUDGET_CHARS / resolvedDeps.length) : 0;

      const dependencyContext = resolvedDeps
        .map((s) => {
          const content = s.deliverable!;
          const truncated = content.length > perDepBudget
            ? content.slice(0, perDepBudget) + `\n... [truncated for length — ${content.length - perDepBudget} more characters not shown]`
            : content;
          return `--- Output from "${s.capability}" (${s.description}) ---\n${truncated}`;
        })
        .join("\n\n");

      // Output budget also has to leave room for input/prompt tokens
      // within the SAME per-minute ceiling — max_tokens: 8000 alone used
      // to meet or exceed this account's entire TPM limit before a
      // single input token was counted. Reduced to something that
      // actually fits alongside real prompt overhead.
      const response = await this.callGroqWithRateLimitRetry({
        model: ["app-builder", "code-review", "planning"].includes(subtask.capability) ? STRONG_MODEL : CHEAP_MODEL,
        max_tokens: subtask.capability === "app-builder" ? 4500 : 2000,
        temperature: 0.5,
        messages: [
          {
            role: "system",
            content: `${this.buildAgentSystemPrompt(agent.name, subtask.capability)}

IMPORTANT FORMATTING RULES:
- You MUST output your deliverable using Markdown formatting.
- Use # for main titles, ## for subtitles, and bullet points for lists.
- If you are writing code, you MUST wrap it in code blocks with the language specified (e.g., \`\`\`javascript ... \`\`\` or \`\`\`solidity ... \`\`\`).
- Do not just output a wall of text. Structure it professionally.${["research", "fact-checking", "data-analysis"].includes(subtask.capability) ? `

- Start with a one-line title (# heading).
- Immediately follow with a "## Key Findings" section: 3-5 bullet points with the most important takeaways — someone should be able to read ONLY this section and get the substance.
- Then the full body with proper ## subsections.
- If you reference facts/data, end with a "## Sources" section listing what you drew from (even if general knowledge, name the domain, e.g. "Industry reporting on X as of your training data").` : ""}${["content-writing", "summarization"].includes(subtask.capability) ? `

- Start with a one-line title (# heading) and a 1-2 sentence summary of what this delivers, before the full content.` : ""}${subtask.capability === "app-builder" ? `

APP-BUILDER OUTPUT FORMAT (required — this output is parsed programmatically):
- Output the COMPLETE contents of every file needed to run the app. No placeholders, no "// rest of the code here", no truncation.
- For EACH file, use exactly this format — a heading line, then a fenced code block with the language:

### FILE: relative/path/to/file.ext
\`\`\`language
<complete file contents>
\`\`\`

- Your response has a hard length limit. If you are not certain everything will fit, WRITE FEWER, SMALLER FILES rather than risk running out of room mid-file — an incomplete submission fails outright, a smaller-but-complete one does not. Do not plan an ambitious file list you might not finish.
- OUTPUT ORDER MATTERS: write package.json/requirements.txt FIRST, then README.md SECOND, THEN your source files. These first two are required for this to be accepted at all — if you're going to run out of room, it must never be these two.
- Include every file needed: source files, package.json/requirements.txt, a README.md with setup + run instructions, and config files. A "working app" means someone can follow the README and actually run it.
- Do not add commentary between files beyond the "### FILE:" heading — keep narrative explanation to a short intro before the first file.
- If a spec was provided below, build to that spec — implement the full feature set it describes, not just the minimum literally stated in the one-line task. But favor a smaller COMPLETE submission over a larger incomplete one — see the length warning above.
- SECRETS & CREDENTIALS: never invent real-looking API keys, database URLs, or secrets. Read them from environment variables (e.g. process.env.SECRET_KEY) with a clearly-labeled placeholder or empty default. Your README MUST include an "## Environment Setup" section listing every required environment variable, what it's for, and concrete instructions to obtain or generate a real value (e.g. "SECRET_KEY — run \`openssl rand -hex 32\` and paste the output" or "DATABASE_URL — create a free Postgres instance on Railway/Supabase/Neon and copy its connection string"). This is what makes the app genuinely complete — a real project never ships hardcoded secrets, and needing the user to configure their own credentials is expected, not a gap, as long as you tell them exactly how.
- If output from a PREVIOUS app-builder module is provided below, you are EXTENDING that codebase, not starting fresh: reuse its existing files, package.json, and navigation/routing structure. Only re-output a file (with its same path) if you are actually modifying it — output that file's FULL updated contents, which will replace the previous version. Do not invent a second, incompatible project structure alongside it. Only include your own README.md if the previous module didn't already provide one.` : ""}${subtask.capability === "code-review" ? `

- You will be given the actual code below. Review THAT specific code — cite real file names and real lines/functions. Do not give generic advice unconnected to what was actually submitted.
- Do not flag environment-variable-based secrets/credentials as a problem — that's correct, expected practice. Only flag it if the README fails to document the required env vars, or if the code around it is actually broken.` : ""}`,
          },
          {
            role: "user",
            content: `TASK CONTEXT: ${task.description}\n\nYOUR SUBTASK: ${subtask.description}${
              dependencyContext ? `\n\n${dependencyContext}` : ""
            }\n\nDeliver your work now. Be thorough, specific, and professionally formatted.`,
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
        await onChainService.disputeSubtask(task.onChainTaskId!, subtask.onChainSubtaskIndex ?? subtask.subtaskIndex);
      } catch (chainErr) {
        this.log(task, "warning", `Could not free on-chain budget for failed subtask ${subtask.subtaskIndex}: ${(chainErr as Error).message}`);
      }
    }
  }

  private async evaluateDeliverable(task: Task, subtask: Subtask): Promise<EvaluationResult> {
    if (subtask.capability === "app-builder") {
      return this.evaluateAppBuilderDeliverable(task, subtask);
    }

    const truncatedDeliverable = (subtask.deliverable || "").length > 6000
      ? subtask.deliverable!.slice(0, 6000) + `\n... [truncated for length — ${subtask.deliverable!.length - 6000} more characters not shown]`
      : subtask.deliverable;

    const response = await this.callGroqWithRateLimitRetry({
      model: CHEAP_MODEL,
      max_tokens: 500,
      temperature: 0.1,
      messages: [
        {
          role: "user",
          content: `Evaluate this deliverable for quality and relevance.

ORIGINAL TASK: ${task.description}
SUBTASK: ${subtask.description}
DELIVERABLE: ${truncatedDeliverable}

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

    const isFollowOnModule = (subtask.dependsOn || []).some(
      (idx) => task.subtasks.find((s) => s.subtaskIndex === idx)?.capability === "app-builder"
    );
    const structural = runStructuralCheck(parsed, { requireManifest: !isFollowOnModule });
    if (!structural.passed) {
      return {
        approved: false,
        score: 10,
        feedback: `Failed structural check: ${structural.issues.join("; ")}`,
        deliverableHash: subtask.deliverableHash!,
      };
    }

    const fileManifest = parsed.files.map((f) => `- ${f.path} (${f.content.split("\n").length} lines)`).join("\n");

    // The generated submission can be close to app-builder's own max_tokens
    // ceiling (~4500 tokens ≈ 18000 chars) — embedding it whole here, on
    // top of this rubric's own instructions, was the actual cause of the
    // 413 persisting even after the generation call itself was fixed.
    // This is a judgment call, not a rebuild — a large-but-representative
    // excerpt is enough for the model to assess real completeness.
    const truncatedSubmission = subtask.deliverable!.length > 10000
      ? subtask.deliverable!.slice(0, 10000) + `\n... [truncated for length — ${subtask.deliverable!.length - 10000} more characters not shown, but the file manifest above lists everything that was submitted]`
      : subtask.deliverable!;

    const response = await this.callGroqWithRateLimitRetry({
      model: STRONG_MODEL,
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

DO NOT PENALIZE — these are correct, standard practice, not incompleteness:
- Secrets, API keys, database URLs, or credentials read from environment variables (e.g. process.env.SECRET_KEY, process.env.DATABASE_URL) with a placeholder/example value or empty default. No AI agent can know the requester's real production secrets, and no real shipped codebase hardcodes them either — that's how every legitimate project works. This is ONLY a problem if either:
  (a) the code would be functionally BROKEN even after the user sets a real value (e.g. the env var is referenced but never actually used, or the logic around it doesn't work), or
  (b) the README does not clearly document which environment variables need to be set, what each is for, and how to obtain/generate a value (e.g. "run openssl rand -hex 32 for SECRET_KEY", "create a free Postgres DB at [provider] and copy its connection string for DATABASE_URL").
A submission that correctly reads secrets from the environment AND documents setup in the README should score as complete on this point, not disputed for "placeholder values."

Be genuinely strict on real completeness — approve only if this would actually run and do what was asked once the documented setup steps are followed, not if it merely "looks like" an app. But do not confuse "requires the user to configure their own credentials" with "incomplete."

FULL SUBMISSION:
${truncatedSubmission}

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
      planning: "You are PlannerBot, creating strategic, actionable plans and structured workflows. When planning an app or product, don't just spec out the literal words in the request — think about what a genuinely competitive, complete version of that category of product needs. If asked to plan a banking app, a real one needs more than login and a balance screen: transfers, bill payments, airtime/data top-up, savings products, transaction history, statements. Name the full feature set a real competitor in that space would have, then let the build stage implement it.",
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
