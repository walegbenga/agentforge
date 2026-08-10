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
  { name: "settleSubtask", type: "function", inputs: [{ name: "taskId", type: "uint256" }, { name: "subtaskIndex", type: "uint256" }, { name: "completionBps", type: "uint256" }], outputs: [] },
  { name: "disputeSubtask", type: "function", inputs: [{ name: "taskId", type: "uint256" }, { name: "subtaskIndex", type: "uint256" }], outputs: [] },
  { name: "completeTask", type: "function", inputs: [{ name: "taskId", type: "uint256" }], outputs: [] },
  { name: "getTask", type: "function", stateMutability: "view", inputs: [{ name: "taskId", type: "uint256" }], outputs: [{ type: "tuple", components: [{ name: "id", type: "uint256" }, { name: "requester", type: "address" }, { name: "description", type: "string" }, { name: "totalBudget", type: "uint256" }, { name: "allocatedBudget", type: "uint256" }, { name: "subtaskCount", type: "uint256" }, { name: "settledCount", type: "uint256" }, { name: "status", type: "uint8" }, { name: "createdAt", type: "uint256" }, { name: "expiresAt", type: "uint256" }] }] },
  { name: "TaskCreated", type: "event", inputs: [{ name: "taskId", type: "uint256", indexed: true }, { name: "requester", type: "address", indexed: true }, { name: "budget", type: "uint256", indexed: false }] },
  { name: "grantRole", type: "function", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { name: "hasRole", type: "function", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const USDC_ABI = [
  { name: "approve", type: "function", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const ORCHESTRATOR_ROLE = keccak256(toBytes("ORCHESTRATOR_ROLE"));

// ── Service ──────────────────────────────────────────────────────────────────

interface OperatorWallet {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  account: any;
  walletClient: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  // Serial queue for this wallet — a promise chain, not a counter. Calls
  // dispatched to the SAME wallet always wait for the previous one to
  // fully confirm before sending the next, so viem's automatic nonce
  // handling is always safe (never two in-flight sends racing for the
  // same nonce). Different wallets still process independently and in
  // parallel — that's where the actual scaling comes from, not from
  // pipelining multiple in-flight transactions on one wallet, which risks
  // a failed send leaving a permanent nonce gap that wedges every later
  // transaction from that wallet (chains require strictly sequential
  // nonces per account — a gap blocks everything after it).
  queue: Promise<unknown>;
}

export class OnChainService {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  private publicClient: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Pool of operator wallets, all holding ORCHESTRATOR_ROLE on-chain. Every
  // assign/settle/dispute/complete call round-robins across this pool
  // instead of funneling through one wallet's sequential nonce — that
  // single-signer bottleneck is what actually caps platform throughput,
  // not LLM speed or database performance.
  private wallets: OperatorWallet[] = [];
  private dispatchCursor = 0;
  private ready: Promise<void>;

  constructor() {
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const rpcUrl = process.env.ARC_RPC_URL;
    if (!rpcUrl) {
      // No hardcoded fallback here on purpose — this repo is public, and a
      // real API key baked in as a "default" is a live credential leak,
      // not just a style issue. Fail loudly instead.
      console.warn("⚠  ARC_RPC_URL not set — on-chain reads/writes disabled");
      return;
    }

    this.publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(rpcUrl),
    });

    // ORCHESTRATOR_PRIVATE_KEYS is a comma-separated pool for scaling
    // concurrent signing. DEPLOYER_PRIVATE_KEY still works standalone for
    // a single-signer setup — every wallet here must actually hold
    // ORCHESTRATOR_ROLE on the deployed contract, or its transactions will
    // simply revert.
    const rawKeys = process.env.ORCHESTRATOR_PRIVATE_KEYS || process.env.DEPLOYER_PRIVATE_KEY;
    if (!rawKeys) {
      console.warn("⚠  Neither ORCHESTRATOR_PRIVATE_KEYS nor DEPLOYER_PRIVATE_KEY set — on-chain writes disabled");
      return;
    }

    const keys = rawKeys.split(",").map((k) => k.trim()).filter((k) => k.length > 0);

    for (const key of keys) {
      const account = privateKeyToAccount(key as `0x${string}`);
      const walletClient = createWalletClient({
        chain: arcTestnet,
        transport: http(rpcUrl),
        account,
      });
      this.wallets.push({ account, walletClient, queue: Promise.resolve() });
    }

    console.log(`✓ OnChainService ready with ${this.wallets.length} operator wallet(s):`, this.wallets.map((w) => w.account.address).join(", "));
  }

  private pickNextWallet(): OperatorWallet {
    if (this.wallets.length === 0) {
      throw new Error("OnChainService: no operator wallets configured (set ORCHESTRATOR_PRIVATE_KEYS or DEPLOYER_PRIVATE_KEY)");
    }
    const wallet = this.wallets[this.dispatchCursor % this.wallets.length];
    this.dispatchCursor = (this.dispatchCursor + 1) % this.wallets.length;
    return wallet;
  }

  /**
   * Picks the next wallet (round-robin) and enqueues the write onto that
   * wallet's serial chain — it runs only after everything already queued
   * for that specific wallet has fully confirmed. Different wallets'
   * queues run independently, which is the actual source of parallelism.
   */
  private async dispatchWrite(params: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }): Promise<string> {
    await this.ready;
    const wallet = this.pickNextWallet();

    const task = wallet.queue.then(async () => {
      const hash = await wallet.walletClient.writeContract(params);
      await this.publicClient.waitForTransactionReceipt({ hash });
      return hash;
    });

    // Keep the chain alive even if this call fails, so the NEXT queued
    // call still runs instead of getting stuck behind a rejected promise.
    wallet.queue = task.catch(() => {});
    return task;
  }

  /**
   * Grants ORCHESTRATOR_ROLE to an additional wallet address — must be
   * called by a wallet holding DEFAULT_ADMIN_ROLE (the deployer, unless
   * ownership was transferred). Use this to add signers to the pool after
   * deployment without redeploying the contract.
   */
  async grantOrchestratorRole(walletAddress: `0x${string}`): Promise<string> {
    return this.dispatchWrite({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "grantRole",
      args: [ORCHESTRATOR_ROLE, walletAddress],
    });
  }

  async hasOrchestratorRole(walletAddress: `0x${string}`): Promise<boolean> {
    await this.ready;
    return this.publicClient.readContract({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "hasRole",
      args: [ORCHESTRATOR_ROLE, walletAddress],
    }) as Promise<boolean>;
  }

  async registerAgent(params: { agentWalletAddress: `0x${string}`; name: string; description: string; capabilities: AgentCapability[]; pricePerTask: number }): Promise<string> {
    const capHashes = params.capabilities.map((c) => keccak256(toBytes(c)) as `0x${string}`);
    return this.dispatchWrite({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "registerAgent",
      args: [BigInt(0), params.name, params.description, "", capHashes, BigInt(params.pricePerTask)],
    });
  }

  async getAgentsByCapability(capability: AgentCapability): Promise<`0x${string}`[]> {
    await this.ready;
    const capHash = keccak256(toBytes(capability)) as `0x${string}`;
    return this.publicClient.readContract({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "getAgentsByCapability",
      args: [capHash],
    }) as Promise<`0x${string}`[]>;
  }

  async getAllAgents(): Promise<`0x${string}`[]> {
    await this.ready;
    return this.publicClient.readContract({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "getAllAgents",
    }) as Promise<`0x${string}`[]>;
  }

  async getAgentOnChain(address: `0x${string}`) {
    await this.ready;
    return this.publicClient.readContract({
      address: addresses.contracts.AgentCapabilityRegistry as `0x${string}`,
      abi: REGISTRY_ABI,
      functionName: "getAgent",
      args: [address],
    });
  }

  async approveEscrow(params: { amount: number }): Promise<string> {
    return this.dispatchWrite({
      address: addresses.contracts.USDC as `0x${string}`,
      abi: USDC_ABI,
      functionName: "approve",
      args: [addresses.contracts.OrchestratorEscrow as `0x${string}`, BigInt(params.amount)],
    });
  }

  /**
   * Reads a task directly from the escrow contract. Used to verify a task
   * that the REQUESTER funded themselves (their own wallet called
   * createTask() and paid the USDC) before we trust it and start spending
   * agent time on it — never take the frontend's word for it.
   */
  async getOnChainTask(taskId: string): Promise<{
    requester: `0x${string}`;
    description: string;
    totalBudget: bigint;
    status: number;
  }> {
    await this.ready;
    const result: any = await this.publicClient.readContract({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "getTask",
      args: [BigInt(taskId)],
    });
    return {
      requester: result.requester,
      description: result.description,
      totalBudget: BigInt(result.totalBudget),
      status: Number(result.status),
    };
  }

  async createTask(params: { description: string; budget: number }): Promise<{ taskId: string; txHash: string }> {
    await this.ready;
    const wallet = this.pickNextWallet();

    const task = wallet.queue.then(async () => {
      const hash = await wallet.walletClient.writeContract({
        address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
        abi: ESCROW_ABI,
        functionName: "createTask",
        args: [params.description, BigInt(params.budget)],
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      const log = receipt.logs.find((l: any) => l.topics.length > 1 && l.topics[0] === keccak256(toBytes("TaskCreated(uint256,address,uint256)")));
      const rawTaskId = log?.topics[1];
      const taskIdString = rawTaskId ? BigInt(rawTaskId).toString() : Date.now().toString();
      return { taskId: taskIdString, txHash: hash };
    });

    wallet.queue = task.catch(() => {});
    return task;
  }

  async assignSubtask(params: { taskId: string; agentWallet: `0x${string}`; capability: AgentCapability; budget: number; description: string }): Promise<string> {
    const capHash = keccak256(toBytes(params.capability)) as `0x${string}`;
    return this.dispatchWrite({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "assignSubtask",
      args: [BigInt(params.taskId), params.agentWallet, capHash, BigInt(params.budget), params.description],
    });
  }

  async settleSubtask(taskId: string, subtaskIndex: number, completionBps: number = 10000): Promise<string> {
    return this.dispatchWrite({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "settleSubtask",
      args: [BigInt(taskId), BigInt(subtaskIndex), BigInt(completionBps)],
    });
  }

  async disputeSubtask(taskId: string, subtaskIndex: number): Promise<string> {
    return this.dispatchWrite({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "disputeSubtask",
      args: [BigInt(taskId), BigInt(subtaskIndex)],
    });
  }

  /**
   * Marks the task complete on-chain and refunds any unallocated budget
   * (e.g. from disputed subtasks) back to the requester. This is the ONLY
   * code path that actually returns that money — without calling this,
   * disputed/unallocated USDC just sits frozen in the escrow contract.
   */
  async completeTask(taskId: string): Promise<string> {
    return this.dispatchWrite({
      address: addresses.contracts.OrchestratorEscrow as `0x${string}`,
      abi: ESCROW_ABI,
      functionName: "completeTask",
      args: [BigInt(taskId)],
    });
  }

  async getTask(taskId: string) {
    await this.ready;
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