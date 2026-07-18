import { circleWalletService } from "./circleWallet.service.js";
import { onChainService } from "./onchain.service.js";
import type { AgentProfile, AgentCapability } from "../types/index.js";
import { randomUUID } from "crypto";

// Pre-defined specialist agents that will be seeded at startup
const SEED_AGENTS: Omit<AgentProfile, "id" | "walletAddress" | "walletId" | "reputationScore" | "jobsCompleted" | "totalEarned" | "active" | "registeredAt">[] = [
  {
    name: "ResearchBot",
    description: "Deep web research, source aggregation, and fact verification specialist",
    capabilities: ["research", "fact-checking", "summarization"],
    erc8004AgentId: undefined,
    pricePerTask: 50_000, // 0.05 USDC
  },
  {
    name: "AnalyticsBot",
    description: "Data analysis, pattern recognition, and quantitative reasoning expert",
    capabilities: ["data-analysis", "math-reasoning"],
    erc8004AgentId: undefined,
    pricePerTask: 75_000, // 0.075 USDC
  },
  {
    name: "CodeReviewBot",
    description: "Code quality analysis, security audits, and best-practices review",
    capabilities: ["code-review", "fact-checking"],
    erc8004AgentId: undefined,
    pricePerTask: 100_000, // 0.1 USDC
  },
  {
    name: "WriterBot",
    description: "Content creation, copywriting, technical documentation, and editing",
    capabilities: ["content-writing", "summarization", "translation"],
    erc8004AgentId: undefined,
    pricePerTask: 60_000, // 0.06 USDC
  },
  {
    name: "PlannerBot",
    description: "Strategic planning, task decomposition, and workflow orchestration",
    capabilities: ["planning", "summarization"],
    erc8004AgentId: undefined,
    pricePerTask: 80_000, // 0.08 USDC
  },
];

export class AgentRegistryService {
  private agents: Map<string, AgentProfile> = new Map();
  private addressIndex: Map<string, string> = new Map(); // address → agent id

  async initialize(): Promise<void> {
  console.log("🤖 Initializing Agent Registry...");

  // In production, skip Circle wallet creation to avoid slow startup
  if (process.env.NODE_ENV === "production" || !process.env.CIRCLE_WALLET_SET_ID) {
    console.log("✓ Agent Registry: running in demo mode (no Circle wallet seeding)");
    // Seed agents with placeholder wallets
    for (const seed of SEED_AGENTS) {
      const agent: AgentProfile = {
        id: randomUUID(),
        ...seed,
        walletAddress: "0x0000000000000000000000000000000000000000",
        walletId: "demo",
        reputationScore: 70,
        jobsCompleted: 0,
        totalEarned: 0,
        active: true,
        registeredAt: new Date().toISOString(),
      };
      this.agents.set(agent.id, agent);
    }
    console.log(`✓ Agent Registry: ${this.agents.size} agents active`);
    return;
  }

  // Full Circle wallet creation (local dev only)
  for (const seed of SEED_AGENTS) {
    try {
      await this.registerAgent(seed);
    } catch (err) {
      console.warn(`  ⚠ Failed to seed ${seed.name}:`, (err as Error).message);
    }
  }
  console.log(`✓ Agent Registry: ${this.agents.size} agents active`);
}

  async registerAgent(
    params: Pick<AgentProfile, "name" | "description" | "capabilities" | "pricePerTask">
  ): Promise<AgentProfile> {
    // 1. Create Circle wallet for this agent
    const { walletId, address } = await circleWalletService.createAgentWallet(params.name);

    // 2. Request testnet USDC
    try {
      await circleWalletService.requestTestnetFunds(walletId);
    } catch {
      // Faucet may rate-limit; non-fatal
    }

    // 3. Register on-chain
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
      console.warn(`  ⚠ On-chain registration skipped for ${params.name}:`, (err as Error).message);
    }

    const agent: AgentProfile = {
      id: randomUUID(),
      name: params.name,
      description: params.description,
      capabilities: params.capabilities,
      walletAddress: address,
      walletId,
      pricePerTask: params.pricePerTask,
      reputationScore: 70, // starting reputation
      jobsCompleted: 0,
      totalEarned: 0,
      active: true,
      registeredAt: new Date().toISOString(),
    };

    this.agents.set(agent.id, agent);
    this.addressIndex.set(address.toLowerCase(), agent.id);

    console.log(`  ✓ ${agent.name} → ${address}`);
    return agent;
  }

  /**
   * Find best available agents for a given capability
   * Sorted by reputation score descending, then by price ascending
   */
  findAgents(capability: AgentCapability, count = 3): AgentProfile[] {
    const matches = Array.from(this.agents.values())
      .filter((a) => a.active && a.capabilities.includes(capability));

    // Sort: reputation desc, then price asc
    matches.sort((a, b) => {
      if (b.reputationScore !== a.reputationScore) {
        return b.reputationScore - a.reputationScore;
      }
      return a.pricePerTask - b.pricePerTask;
    });

    return matches.slice(0, count);
  }

  getBestAgent(capability: AgentCapability): AgentProfile | null {
    return this.findAgents(capability, 1)[0] ?? null;
  }

  getById(id: string): AgentProfile | undefined {
    return this.agents.get(id);
  }

  getByAddress(address: string): AgentProfile | undefined {
    const id = this.addressIndex.get(address.toLowerCase());
    return id ? this.agents.get(id) : undefined;
  }

  getAll(): AgentProfile[] {
    return Array.from(this.agents.values());
  }

  updateReputation(agentId: string, scoreDelta: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.reputationScore = Math.max(0, Math.min(100, agent.reputationScore + scoreDelta));
  }

  recordCompletion(agentId: string, earned: number): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.jobsCompleted++;
    agent.totalEarned += earned;
    // Reputation grows with successful completions (diminishing returns)
    const delta = Math.max(0.5, 5 / (1 + agent.jobsCompleted * 0.1));
    this.updateReputation(agentId, delta);
  }

  recordDispute(agentId: string): void {
    this.updateReputation(agentId, -10);
  }
}

export const agentRegistry = new AgentRegistryService();
