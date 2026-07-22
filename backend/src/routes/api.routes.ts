import { Router, Request, Response } from "express";
import { orchestrationEngine } from "../services/orchestration.service.js";
import { agentRegistry } from "../services/agentRegistry.service.js";
import { z } from "zod";

const router = Router();

const CreateTaskSchema = z.object({
  description: z.string().min(10).max(2000),
  budget: z.number().int().min(100_000).max(100_000_000),
  requesterAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, "Invalid address"),
});

router.post("/tasks", async (req: Request, res: Response) => {
  try {
    const body = CreateTaskSchema.parse(req.body);
    const task = await orchestrationEngine.createAndRunTask(body);
    res.status(201).json({ success: true, data: task });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ success: false, error: err.errors });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/tasks", (req: Request, res: Response) => {
  const { address } = req.query;

  const tasks = address
    ? orchestrationEngine.getTasksByAddress(address as string)
    : orchestrationEngine.getAllTasks();

  res.json({ success: true, data: tasks });
});

router.get("/tasks/:id", (req: Request, res: Response) => {
  const task = orchestrationEngine.getTask(req.params.id);
  if (!task) return res.status(404).json({ success: false, error: "Task not found" });
  res.json({ success: true, data: task });
});

router.get("/agents", (_req: Request, res: Response) => {
  res.json({ success: true, data: agentRegistry.getAll() });
});

router.get("/agents/:id", (req: Request, res: Response) => {
  const agent = agentRegistry.getById(req.params.id);
  if (!agent) return res.status(404).json({ success: false, error: "Agent not found" });
  res.json({ success: true, data: agent });
});

const RegisterAgentSchema = z.object({
  name: z.string().min(3).max(64),
  description: z.string().min(10).max(500),
  capabilities: z.array(z.string()).min(1).max(10),
  pricePerTask: z.number().int().min(100),
});

router.post("/agents", async (req: Request, res: Response) => {
  try {
    const body = RegisterAgentSchema.parse(req.body);
    const agent = await agentRegistry.registerAgent(body as any);
    res.status(201).json({ success: true, data: agent });
  } catch (err: any) {
    if (err.name === "ZodError") return res.status(400).json({ success: false, error: err.errors });
    res.status(500).json({ success: false, error: err.message });
  }
});

router.get("/stats", (_req: Request, res: Response) => {
  const agents = agentRegistry.getAll();
  const tasks = orchestrationEngine.getAllTasks();
  const totalEarned = agents.reduce((s, a) => s + a.totalEarned, 0);
  const totalJobsCompleted = agents.reduce((s, a) => s + a.jobsCompleted, 0);
  const completedTasks = tasks.filter((t) => t.status === "completed").length;
  const totalVolume = tasks.reduce((s, t) => s + t.totalBudget, 0);

  res.json({
    success: true,
    data: {
      agents: agents.length,
      tasks: tasks.length,
      completedTasks,
      totalVolume,
      totalEarned,
      totalJobsCompleted,
      averageReputationScore: agents.length > 0
        ? agents.reduce((s, a) => s + a.reputationScore, 0) / agents.length
        : 0,
    },
  });
});

router.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default router;
