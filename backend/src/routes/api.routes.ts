import { Router, Request, Response } from "express";
import { prisma } from "../services/db.service.js";
import { orchestrationEngine } from "../services/orchestration.service.js";
import { agentRegistry } from "../services/agentRegistry.service.js";
import { z } from "zod";
import { SiweMessage } from "siwe"; // ✅ Added SIWE

const router = Router();

// ✅ NEW: SIWE Verification Middleware
const verifySiwe = async (req: Request, res: Response, next: Function) => {
  try {
    const { signature, message } = req.body;
    if (!signature || !message) {
      return res.status(401).json({ success: false, error: "Cryptographic signature and message required" });
    }

    const siweMessage = new SiweMessage(message);
    const { success, error } = await siweMessage.verify({ signature });

    if (!success) {
      return res.status(401).json({ success: false, error: "Invalid signature: " + error });
    }

    // Attach the cryptographically verified address to the request
    (req as any).verifiedAddress = siweMessage.address.toLowerCase();
    next();
  } catch (err) {
    console.error("SIWE Verification Error:", err);
    res.status(401).json({ success: false, error: "Authentication failed" });
  }
};

// ─── Tasks ───────────────────────────────────────────────────────────────────

const CreateTaskSchema = z.object({
  description: z.string().min(10).max(2000),
  budget: z.number().int().min(100_000).max(100_000_000),
  requesterAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
});

// ✅ PROTECTED: Requires valid SIWE signature
router.post("/tasks", verifySiwe, async (req: Request, res: Response) => {
  try {
    const verifiedAddress = (req as any).verifiedAddress; // ✅ Trust the signature, not the body
    const body = CreateTaskSchema.parse(req.body);
    
    const task = await orchestrationEngine.createAndRunTask({
      ...body,
      requesterAddress: verifiedAddress, 
    });
    res.status(201).json({ success: true, data: task });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ success: false, error: err.errors });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/tasks", async (req: Request, res: Response) => {
  try {
    const { address } = req.query;
    const tasks = address
      ? await orchestrationEngine.getTasksByAddress(address as string)
      : await orchestrationEngine.getAllTasks();
    res.json({ success: true, data: tasks });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/tasks/:id", async (req: Request, res: Response) => {
  try {
    const task = await orchestrationEngine.getTask(req.params.id);
    if (!task) return res.status(404).json({ success: false, error: "Task not found" });
    res.json({ success: true, data: task });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const ClaimSubtaskSchema = z.object({
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
  subtaskIndex: z.number().int().min(0),
});

// ✅ PROTECTED: Requires valid SIWE signature
router.post("/tasks/:id/claim", verifySiwe, async (req: Request, res: Response) => {
  try {
    const verifiedAddress = (req as any).verifiedAddress;
    const { id } = req.params;
    const body = ClaimSubtaskSchema.parse(req.body);
    
    // Ensure the claiming wallet matches the cryptographically verified wallet
    if (body.walletAddress.toLowerCase() !== verifiedAddress) {
      return res.status(403).json({ success: false, error: "Wallet address mismatch" });
    }

    const task = await orchestrationEngine.claimSubtask(id, body.subtaskIndex, verifiedAddress);
    res.json({ success: true, data: task });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ success: false, error: err.errors });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Agents ──────────────────────────────────────────────────────────────────

router.get("/agents", async (_req: Request, res: Response) => {
  try {
    const agents = await agentRegistry.getAll();
    res.json({ success: true, data: agents });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/agents/:id", async (req: Request, res: Response) => {
  try {
    const agent = await agentRegistry.getById(req.params.id);
    if (!agent) return res.status(404).json({ success: false, error: "Agent not found" });
    res.json({ success: true, data: agent });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const RegisterAgentSchema = z.object({
  name: z.string().min(3).max(64),
  description: z.string().min(10).max(500),
  capabilities: z.array(z.string()).min(1).max(10),
  walletAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
  pricePerTask: z.number().int().min(100),
});

// ✅ PROTECTED: Requires valid SIWE signature
router.post("/agents", verifySiwe, async (req: Request, res: Response) => {
  try {
    const verifiedAddress = (req as any).verifiedAddress;
    const body = RegisterAgentSchema.parse(req.body);

    if (body.walletAddress.toLowerCase() !== verifiedAddress) {
      return res.status(403).json({ success: false, error: "Wallet address mismatch" });
    }

    const agent = await agentRegistry.registerAgent({ ...body, walletAddress: verifiedAddress });
    res.status(201).json({ success: true, data: agent });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ success: false, error: err.errors });
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ PROTECTED: Requires valid SIWE signature
router.post("/agents/connect", verifySiwe, async (req: Request, res: Response) => {
  try {
    const verifiedAddress = (req as any).verifiedAddress;
    // We trust the verified address completely, ignoring the body
    const agent = await agentRegistry.getOrCreateAgent(verifiedAddress);
    res.json({ success: true, data: agent });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Stats ───────────────────────────────────────────────────────────────────

router.get("/stats", async (_req: Request, res: Response) => {
  try {
    const agents = await agentRegistry.getAll();
    const tasks = await orchestrationEngine.getAllTasks();

    const totalEarned = agents.reduce((s: number, a: any) => s + a.totalEarned, 0);
    const totalJobsCompleted = agents.reduce((s: number, a: any) => s + a.jobsCompleted, 0);
    const completedTasks = tasks.filter((t: any) => t.status === "completed").length;
    const pendingSubtasks = tasks.reduce(
      (s: number, t: any) => s + t.subtasks.filter((sub: any) => sub.status === "pending").length, 0
    );
    const totalVolume = tasks.reduce((s: number, t: any) => s + t.totalBudget, 0);

    res.json({
      success: true,
      data: {
        agents: agents.length,
        tasks: tasks.length,
        completedTasks,
        pendingSubtasks,
        totalVolume,
        totalEarned,
        totalJobsCompleted,
        averageReputationScore: agents.length > 0
          ? agents.reduce((s: number, a: any) => s + a.reputationScore, 0) / agents.length
          : 0,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stats/me", async (req: Request, res: Response) => {
  try {
    const { address } = req.query;
    if (!address || typeof address !== "string") {
      return res.status(400).json({ success: false, error: "Wallet address is required" });
    }

    const normalizedAddress = address.toLowerCase();

    const myAgents = await prisma.agent.findMany({
      where: { walletAddress: normalizedAddress },
      select: { jobsCompleted: true },
    });
    const myAgentsCount = myAgents.length;
    const myJobsCompleted = myAgents.reduce((sum, a) => sum + a.jobsCompleted, 0);

    const myCompletedTasks = await prisma.task.count({
      where: { 
        requesterAddress: { equals: normalizedAddress, mode: "insensitive" }, 
        status: "completed" 
      },
    });

    const myTasksVolume = await prisma.task.findMany({
      where: { 
        requesterAddress: { equals: normalizedAddress, mode: "insensitive" } 
      },
      select: { totalBudget: true },
    });
    const myTotalVolume = myTasksVolume.reduce((sum, t) => sum + t.totalBudget, 0);

    res.json({
      success: true,
      data: {
        agents: myAgentsCount,
        completedTasks: myCompletedTasks,
        totalVolume: myTotalVolume,
        jobsCompleted: myJobsCompleted,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;