import { circleWalletService } from "./circleWallet.service.js";
import { onChainService } from "./onchain.service.js";
import { prisma } from "../lib/prisma.js";
import type { AgentProfile, AgentCapability } from "../types/index.js";
import { randomUUID } from "crypto";

const SEED_AGENTS: Omit<AgentProfile, "id" | "walletAddress" | "walletId" | "reputationScore" | "jobsCompleted" | "totalEarned" | "active" | "registeredAt">[] = [
  { name: "ResearchBot", description: "Deep web research, source aggregation, and fact verification specialist", capabilities: ["research", "fact-checking", "summarization"], erc8004AgentId: undefined, pricePerTask: 50_000 },
  { name: "AnalyticsBot", description: "Data analysis, pattern recognition, and quantitative reasoning expert", capabilities: ["data-analysis", "math-reasoning"], erc8004AgentId: undefined, pricePerTask: 75_000 },
  { name: "CodeReviewBot", description: "Code quality analysis, security audits, and best-practices review", capabilities: ["code-review", "fact-checking"], erc8004AgentId: undefined, pricePerTask: 100_000 },
  { name: "WriterBot", description: "Content creation, copywriting, technical documentation, and editing", capabilities: ["content-writing", "summarization", "translation"], erc8004AgentId: undefined, pricePerTask: 60_000 },
  { name: "PlannerBot", description: "Strategic planning, task decomposition, and workflow orchestration", capabilities: ["planning", "summarization"], erc8004AgentId: undefined, pricePerTask: 80_000 },
];

export class AgentRegistryService {
  async initialize(): Promise<void> {
    console.log("🤖 Initializing Agent Registry...");

    if (process.env.NODE_ENV === "production" || !process.env.CIRCLE_WALLET_SET_ID) {
      console.log("✓ Agent Registry: running in demo mode (no Circle wallet seeding)");
      for (const seed of SEED_AGENTS) {
        await prisma.agent.upsert({
          where: { name: seed.name },
          update: {},
          create: {
            id: randomUUID(),
            ...seed,
            walletAddress: "0x0000000000000000000000000000000000000000",
            walletId: "demo",
            reputationScore: 70,
            jobsCompleted: 0,
            totalEarned: 0,
            active: true,
          },
        });
      }
      console.log("✓ Agent Registry: seeded demo agents");
      return;
    }

    for (const seed of SEED_AGENTS) {
      try {
        await this.registerAgent(seed);
      } catch (err) {
        console.warn(` ⚠ Failed to seed ${seed.name}:`, (err as Error).message);
      }
    }
    console.log("✓ Agent Registry: agents active");
  }

  async registerAgent(params: Pick<AgentProfile, "name" | "description" | "capabilities" | "pricePerTask">): Promise<AgentProfile> {
    const { walletId, address } = await circleWalletService.createAgentWallet(params.name);
    try { await circleWalletService.requestTestnetFunds(walletId); } catch {}

    let txHash: string | undefined;
    try {
      txHash = await onChainService.registerAgent({
        agentWalletAddress: address as `0x${string}`,
        name: params.name,
        description: params.description,
        capabilities: params.capabilities,
        pricePerTask: params.pricePerTask,
      });
    } catch (err) {
      console.warn(` ⚠ On-chain registration skipped for ${params.name}:`, (err as Error).message);
    }

    const agent = await prisma.agent.create({
      data: {
        id: randomUUID(),
        name: params.name,
        description: params.description,
        capabilities: params.capabilities,
        walletAddress: address.toLowerCase(),
        walletId,
        erc8004AgentId: txHash,
        pricePerTask: params.pricePerTask,
        reputationScore: 70,
        jobsCompleted: 0,
        totalEarned: 0,
        active: true,
      },
    });
    console.log(` ✓ ${agent.name} → ${address}`);
    return this.mapToProfile(agent);
  }

  async findAgents(capability: AgentCapability, count = 3): Promise<AgentProfile[]> {
    const agents = await prisma.agent.findMany({
      where: { active: true, capabilities: { has: capability } },
      orderBy: [{ reputationScore: 'desc' }, { pricePerTask: 'asc' }],
      take: count,
    });
    return agents.map(this.mapToProfile);
  }

  async getBestAgent(capability: AgentCapability): Promise<AgentProfile | null> {
    const agents = await this.findAgents(capability, 1);
    return agents[0] ?? null;
  }

  async getById(id: string): Promise<AgentProfile | undefined> {
    const agent = await prisma.agent.findUnique({ where: { id } });
    return agent ? this.mapToProfile(agent) : undefined;
  }

  async getByAddress(address: string): Promise<AgentProfile | undefined> {
    const agent = await prisma.agent.findUnique({ where: { walletAddress: address.toLowerCase() } });
    return agent ? this.mapToProfile(agent) : undefined;
  }

  async getAll(): Promise<AgentProfile[]> {
    const agents = await prisma.agent.findMany();
    return agents.map(this.mapToProfile);
  }

  async updateReputation(agentId: string, scoreDelta: number): Promise<void> {
    await prisma.agent.update({
      where: { id: agentId },
      data: { reputationScore: { increment: scoreDelta } },
    });
  }

  async recordCompletion(agentId: string, earned: number): Promise<void> {
    const agent = await prisma.agent.findUnique({ where: { id: agentId } });
    if (!agent) return;
    const delta = Math.max(0.5, 5 / (1 + (agent.jobsCompleted + 1) * 0.1));
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        jobsCompleted: { increment: 1 },
        totalEarned: { increment: earned },
        reputationScore: { increment: delta },
      },
    });
  }

  async recordDispute(agentId: string): Promise<void> {
    await this.updateReputation(agentId, -10);
  }

  private mapToProfile(dbAgent: any): AgentProfile {
    return { ...dbAgent, registeredAt: dbAgent.registeredAt.toISOString(), capabilities: dbAgent.capabilities as AgentCapability[] };
  }
}

export const agentRegistry = new AgentRegistryService();