import { prisma } from "./db.service.js";
import type { AgentProfile, AgentCapability } from "../types/index.js";

const DEFAULT_CAPABILITIES: AgentCapability[] = [
  "research",
  "data-analysis",
  "content-writing",
  "summarization",
  "planning",
  "app-builder",
];

class AgentRegistryService {

  async getAll(): Promise<AgentProfile[]> {
    const agents = await prisma.agent.findMany({
      where: { active: true },
      orderBy: { reputationScore: "desc" },
    });
    return agents.map(dbAgentToProfile);
  }

  async getById(id: string): Promise<AgentProfile | null> {
    const agent = await prisma.agent.findUnique({ where: { id } });
    return agent ? dbAgentToProfile(agent) : null;
  }

  async getByWallet(walletAddress: string): Promise<AgentProfile | null> {
    const agent = await prisma.agent.findUnique({
      where: { walletAddress: walletAddress.toLowerCase() },
    });
    return agent ? dbAgentToProfile(agent) : null;
  }

  // ✅ UPSERT: Creates new or updates existing agent for this wallet
  async registerAgent(params: {
    name: string;
    description: string;
    capabilities: string[];
    walletAddress: string;
    pricePerTask: number;
  }): Promise<AgentProfile> {
    const normalizedAddress = params.walletAddress.toLowerCase();

    const existing = await prisma.agent.findUnique({
      where: { walletAddress: normalizedAddress },
    });

    if (existing) {
      const updated = await prisma.agent.update({
        where: { walletAddress: normalizedAddress },
        data: {
          name: params.name,
          description: params.description,
          capabilities: params.capabilities,
          pricePerTask: params.pricePerTask,
        },
      });
      return dbAgentToProfile(updated);
    }

    const agent = await prisma.agent.create({
      data: {
        name: params.name,
        description: params.description,
        capabilities: params.capabilities,
        walletAddress: normalizedAddress,
        pricePerTask: params.pricePerTask,
      },
    });

    console.log(`🤖 New agent registered: ${agent.name} (${normalizedAddress})`);
    return dbAgentToProfile(agent);
  }

  // ✅ AUTO-REGISTER: Called automatically when a wallet connects
  async getOrCreateAgent(walletAddress: string): Promise<AgentProfile> {
    const normalizedAddress = walletAddress.toLowerCase();

    const existing = await prisma.agent.findUnique({
      where: { walletAddress: normalizedAddress },
    });

    if (existing) {
      return dbAgentToProfile(existing);
    }

    const shortAddr = normalizedAddress.slice(0, 6) + "..." + normalizedAddress.slice(-4);
    const agent = await prisma.agent.create({
      data: {
        name: `Agent-${shortAddr}`,
        description: "Autonomous AI agent in the ForgeOps AI economy",
        capabilities: DEFAULT_CAPABILITIES,
        walletAddress: normalizedAddress,
        pricePerTask: 500000, // 0.5 USDC default
      },
    });

    console.log(`🤖 Auto-registered agent: ${agent.name} (${normalizedAddress})`);
    return dbAgentToProfile(agent);
  }

  async getBestAgent(capability: AgentCapability): Promise<AgentProfile | null> {
    const agents = await prisma.agent.findMany({
      where: {
        active: true,
        capabilities: { has: capability },
      },
      orderBy: [{ reputationScore: "desc" }, { pricePerTask: "asc" }],
    });

    if (agents.length === 0) return null;
    return dbAgentToProfile(agents[0]);
  }

  async recordCompletion(agentId: string, earnings: number): Promise<void> {
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        jobsCompleted: { increment: 1 },
        totalEarned: { increment: earnings },
        reputationScore: { increment: 2 },
      },
    });
  }

  async recordDispute(agentId: string): Promise<void> {
    await prisma.agent.update({
      where: { id: agentId },
      data: {
        reputationScore: { decrement: 10 },
      },
    });
  }
}

function dbAgentToProfile(agent: any): AgentProfile {
  return {
    id: agent.id,
    name: agent.name,
    description: agent.description,
    capabilities: agent.capabilities,
    walletAddress: agent.walletAddress,
    pricePerTask: agent.pricePerTask,
    reputationScore: agent.reputationScore,
    jobsCompleted: agent.jobsCompleted,
    totalEarned: agent.totalEarned,
    active: agent.active,
    registeredAt: agent.registeredAt.toISOString(),
  };
}

export const agentRegistry = new AgentRegistryService();