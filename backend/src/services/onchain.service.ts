import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { addresses } from "../config/addresses.js";
import { arcTestnet } from "./circleWallet.service.js";
import type { AgentCapability } from "../types/index.js";

// ── ABIs ─────────────────────────────────────────────────────────────────────

const REGISTRY_ABI = [
  { name: "registerAgent", type: "function", inputs: [{ name: "erc8004AgentId", type: "uint256" }, { name: "name", type: "string" }, { name: "description", type: "string" }, { name: "metadataURI", type: "string" }, { name: "capabilities", type: "bytes32[]" }, { name: "pricePerTask", type: "uint256" }], outputs: [] },
  { name: "getAgent", type: "function", stateMutability: "view", inputs: [{ name: "wallet", type: "address" }], outputs: [{ type: "tuple", components: [{ name: "wallet", type: "address" }, { name: "erc8004AgentId", type: "uint256" }, { name: "name", type: "string" }, { name: "description", type: "string" }, { name: "metadataURI", type: "string" }, { name: "capabilities", type: "bytes32[]" }, { name: "pricePerTask", type: "uint256" }, { name: "totalJobsCompleted", type: "uint256" }, { name: "totalEarned", type: "uint256" }, { name: "active", type: "bool" }, { name: "registeredAt", type: "uint256" }] }] },
  { name: "getAgentsByCapability", type: "function", stateMutability: "view", inputs: [{ name: "capability", type: "bytes32" }], outputs: [{ name: "", type: "address[]" }] },
  { name: "getAllAgents", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address[]" }] },
  { name: "isRegistered", type: "function", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const ESCROW_ABI = [
  { name: "createTask", type: "function", inputs: [{ name: "description", type: "string" }, { name: "budget", type: "uint256" }], outputs: [{ name: "taskId", type: "uint256" }] },
  { name: "assignSubtask", type: "function", inputs: [{ name: "taskId", type: "uint256" }, { name: "agentWallet", type: "address" }, { name: "capability", type: "bytes32" }, { name: "budget", type: "uint256" }, { name: "description", type: "string" }], outputs: [] },
  { name: "settleSubtask", type: "function", inputs: [{ name: "taskId", type: "uint256" }, { name: "subtaskIndex", type: "uint256" }], outputs: [] },
  { name: "disputeSubtask", type: "function", inputs: [{ name: "taskId", type: "uint256" }, { name: "subtaskIndex", type: "uint256" }], outputs: [] },
  { name: "getTask", type: "function", stateMutability: "view", inputs: [{ name: "taskId", type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "id", type: "uint256" }, { name: "requester", type: "address" }, { name: "description", type: "string" }, { name: "totalBudget", type: "uint256" }, { name: "allocatedBudget", type: "uint256" }, { name: "subtaskCount", type: "uint256" }, { name: "settledCount", type: "uint256" }, { name: "status", type: "uint8" }, { name: "createdAt", type: "uint256" }, { name: "expiresAt", type: "uint256" }] }] },
  { name: "TaskCreated", type: "event", inputs: [{ name: "taskId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "budget", type: "uint256", indexed: false }] },
] as const;

const USDC_ABI = [
  { name: "approve", type: "function", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

// ── Service ──────────────────────────────────────────────────────────────────

export class OnChainService {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private publicClient: any;
  private walletClient: any;
  private orchestratorAccount: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  constructor() {
    this.publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(process.env.ARC_RPC_URL || "https://arc-testnet.g.alchemy.com/v2/alch_cojzcvLgQaWVcCE2BWXpp"),
    });

    const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
    if (!privateKey) {
      console.warn("⚠  DEPLOYER_PRIVATE_KEY not set — on-chain writes disabled");
      return;
    }

    this.orchestratorAccount = privateKeyToAccount(privateKey as `0x${string}`);
    this.walletClient = createWalletClient({
      chain: arcTestnet,
      transport: http(process.env.ARC_RPC_URL || "https://https://arc-testnet.g.alchemy.com/v2/alch_cojzcvLgQaWVcCE2BWXpp"),
      account: this.orchestratorAccount,
    });

    console.log("✓ OnChainService ready:", this.orchestratorAccount.address);
  }

  private getWalletClient() {
    if (!this.walletClient) throw new Error("OnChainService: DEPLOYER_PRIVATE_KEY not set");
    return this.walletClient;
  }

  async registerAgent(params: { agentWalletAddress: `0x${string}`; name: string; description: string; capabilities: AgentCapability[]; pricePerTask: number }): Promise<string> {
    const capHashes = params.capabilities.map((c) => keccak256(toBytes(c)) as `0x${string}`);
    const hash = await this.getWalletClient().writeContract({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "registerAgent",
      args: [BigInt(0), params.name, params.description, "", capHashes, BigInt(params.pricePerTask)],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  async getAgentsByCapability(capability: AgentCapability): Promise<`0x${string}`[]> {
    const capHash = keccak256(toBytes(capability)) as `0x${string}`;
    return this.publicClient.readContract({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "getAgentsByCapability",
      args: [capHash],
    }) as Promise<`0x${string}`[]>;
  }

  async getAllAgents(): Promise<`0x${string}`[]> {
    return this.publicClient.readContract({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "getAllAgents",
    }) as Promise<`0x${string}`[]>;
  }

  async getAgentOnChain(address: `0x${string}`) {
    return this.publicClient.readContract({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "getAgent",
      args: [address],
    });
  }

  async approveEscrow(params: { amount: number }): Promise<string> {
    const hash = await this.getWalletClient().writeContract({
      address: addresses.contracts.USDC as `0x${string}`,
      abi: USDC_ABI,
      functionName: "approve",
      args: [addresses.contracts.OrchestratorEscrow as `0x${string}`, BigInt(params.amount)],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ✅ FIXED: Return type is now { taskId: string; txHash: string }
  async createTask(params: { description: string; budget: number }): Promise<{ taskId: string; txHash: string }> {
    const hash = await this.getWalletClient().writeContract({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "createTask",
      args: [params.description, BigInt(params.budget)],
    });
    
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    
    // Find the TaskCreated event log
    const log = receipt.logs.find((l: any) => l.topics.length > 1 && l.topics[0] === keccak256(toBytes("TaskCreated(uint256,address,uint256)")));
    
    // topics[1] is the indexed uint256 taskId. Convert hex to decimal string safely.
    const rawTaskId = log?.topics[1];
    const taskIdString = rawTaskId ? BigInt(rawTaskId).toString() : Date.now().toString();
    
    return { taskId: taskIdString, txHash: hash };
  }

  // ✅ FIXED: taskId param is now string
  async assignSubtask(params: { taskId: string; agentWallet: `0x${string}`; capability: AgentCapability; budget: number; description: string }): Promise<string> {
    const capHash = keccak256(toBytes(params.capability)) as `0x${string}`;
    const hash = await this.getWalletClient().writeContract({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "assignSubtask",
      args: [BigInt(params.taskId), params.agentWallet, capHash, BigInt(params.budget), params.description],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ✅ FIXED: taskId param is now string
  async settleSubtask(taskId: string, subtaskIndex: number): Promise<string> {
    const hash = await this.getWalletClient().writeContract({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "settleSubtask",
      args: [BigInt(taskId), BigInt(subtaskIndex)],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ✅ FIXED: taskId param is now string
  async disputeSubtask(taskId: string, subtaskIndex: number): Promise<string> {
    const hash = await this.getWalletClient().writeContract({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "disputeSubtask",
      args: [BigInt(taskId), BigInt(subtaskIndex)],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ✅ FIXED: taskId param is now string
  async getTask(taskId: string) {
    return this.publicClient.readContract({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "getTask",
      args: [BigInt(taskId)],
    });
  }

  hashDeliverable(content: string): `0x${string}` { return keccak256(toBytes(content)); }
  formatUSDC(amount: number): string { return (amount / 1_000_000).toFixed(6); }
  parseUSDC(amount: string): number { return Math.floor(parseFloat(amount) * 1_000_000); }
}

export const onChainService = new OnChainService();