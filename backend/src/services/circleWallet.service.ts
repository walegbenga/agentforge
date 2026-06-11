import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from "viem";
import type { AgentProfile } from "../types/index.js";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load deployed contract addresses
const addressesPath = path.join(__dirname, "../../../addresses.json");
let CONTRACT_ADDRESSES: Record<string, any> = {};
if (fs.existsSync(addressesPath)) {
  CONTRACT_ADDRESSES = JSON.parse(fs.readFileSync(addressesPath, "utf-8"));
}

// Arc Testnet chain config
export const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
  },
} as const;

export class CircleWalletService {
  private client: ReturnType<typeof initiateUserControlledWalletsClient>;
  private walletSetId: string;

  constructor() {
    this.client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
    this.walletSetId = process.env.CIRCLE_WALLET_SET_ID!;
  }

  /**
   * Create a new Circle developer-controlled wallet for an agent
   */
  async createAgentWallet(agentName: string): Promise<{ walletId: string; address: string }> {
    const response = await this.client.createWallets({
      accountType: "SCA",
      blockchains: ["ARC-TESTNET"],
      count: 1,
      walletSetId: this.walletSetId,
      metadata: [
        {
          name: `AgentForge - ${agentName}`,
          refId: `agent-${Date.now()}`,
        },
      ],
    });

    const wallet = response.data?.wallets?.[0];
    if (!wallet) throw new Error("Failed to create wallet");

    return { walletId: wallet.id, address: wallet.address };
  }

  /**
   * Get USDC balance for a wallet
   */
  async getBalance(walletId: string): Promise<number> {
    const response = await this.client.getWalletTokenBalance({ id: walletId });
    const balances = response.data?.tokenBalances ?? [];

    // Find USDC balance
    const usdc = balances.find(
      (b: any) =>
        b.token?.symbol === "USDC" ||
        b.token?.address?.toLowerCase() === CONTRACT_ADDRESSES.contracts?.USDC?.toLowerCase()
    );

    return usdc ? parseFloat(usdc.amount) : 0;
  }

  /**
   * Transfer USDC from a developer-controlled agent wallet to another address
   */
  async transferUSDC(params: {
    sourceWalletId: string;
    destinationAddress: string;
    amount: string; // human-readable USDC e.g. "1.5"
  }): Promise<string> {
    const response = await this.client.createTransaction({
      walletId: params.sourceWalletId,
      tokenAddress: CONTRACT_ADDRESSES.contracts?.USDC,
      destinationAddress: params.destinationAddress,
      amounts: [params.amount],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    const txHash = response.data?.transaction?.txHash;
    if (!txHash) throw new Error("Transfer failed: no txHash returned");

    return txHash;
  }

  /**
   * Approve USDC spending for OrchestratorEscrow (called before createTask)
   */
  async approveEscrow(params: {
    walletId: string;
    amount: string; // human-readable USDC
  }): Promise<string> {
    const escrowAddress = CONTRACT_ADDRESSES.contracts?.OrchestratorEscrow;
    if (!escrowAddress) throw new Error("Escrow address not found");

    // ERC-20 approve call
    const approveAbi = [
      {
        name: "approve",
        type: "function",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [{ name: "", type: "bool" }],
      },
    ];

    const amountWei = parseUnits(params.amount, 6).toString();

    const response = await this.client.createContractExecutionTransaction({
      walletId: params.walletId,
      contractAddress: CONTRACT_ADDRESSES.contracts?.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [escrowAddress, amountWei],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });

    return response.data?.transaction?.txHash ?? "";
  }

  /**
   * Wait for a Circle transaction to confirm
   */
  async waitForTransaction(txHash: string, maxWaitMs = 30000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      try {
        const publicClient = createPublicClient({
          chain: arcTestnet,
          transport: http(),
        });
        const receipt = await publicClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (receipt) return receipt.status === "success";
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  /**
   * Fund a testnet wallet with USDC from faucet
   */
  async requestTestnetFunds(walletId: string): Promise<void> {
    // Circle testnet faucet
    await this.client.requestTestnetTokens({
      address: walletId,
      blockchain: "ARC-TESTNET",
      native: false,
      usdc: true,
    });
  }

  async getWallet(walletId: string) {
    const response = await this.client.getWallet({ id: walletId });
    return response.data?.wallet;
  }
}

export const circleWalletService = new CircleWalletService();
