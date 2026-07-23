import { initiateDeveloperControlledWalletsClient } from "@circle-fin/developer-controlled-wallets";
import { createPublicClient, http } from "viem";
import { CONTRACT_ADDRESSES } from "../config/addresses.js";

export const arcTestnet = {
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 6 },
  rpcUrls: {
    default: { http: ["https://https://arc-testnet.g.alchemy.com/v2/alch_cojzcvLgQaWVcCE2BWXpp"] },
  },
} as const;

export class CircleWalletService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private client: any;
  private walletSetId: string;

  constructor() {
    this.client = initiateDeveloperControlledWalletsClient({
      apiKey: process.env.CIRCLE_API_KEY!,
      entitySecret: process.env.CIRCLE_ENTITY_SECRET!,
    });
    this.walletSetId = process.env.CIRCLE_WALLET_SET_ID!;
  }

  async createAgentWallet(agentName: string): Promise<{ walletId: string; address: string }> {
    const response = await this.client.createWallets({
      accountType: "SCA",
      blockchains: ["EVM-TESTNET"],
      count: 1,
      walletSetId: this.walletSetId,
      metadata: [{ name: `AgentForge - ${agentName}`, refId: `agent-${Date.now()}` }],
    });

    const wallet = response.data?.wallets?.[0];
    if (!wallet) throw new Error("Failed to create wallet");
    return { walletId: wallet.id, address: wallet.address ?? "" };
  }

  async getBalance(walletId: string): Promise<number> {
    try {
      const response = await this.client.getWalletTokenBalance({ id: walletId });
      const balances = response.data?.tokenBalances ?? [];
      const usdc = balances.find(
        (b: any) =>
          b.token?.symbol === "USDC" ||
          b.token?.address?.toLowerCase() ===
            CONTRACT_ADDRESSES.contracts?.USDC?.toLowerCase()
      );
      return usdc ? parseFloat(usdc.amount ?? "0") : 0;
    } catch {
      return 0;
    }
  }

  async transferUSDC(params: {
    sourceWalletId: string;
    destinationAddress: string;
    amount: string;
  }): Promise<string> {
    const response = await this.client.createTransaction({
      walletId: params.sourceWalletId,
      destinationAddress: params.destinationAddress,
      amount: params.amount,
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txData = response.data as any;
    const txHash = txData?.transaction?.txHash ?? txData?.txHash ?? "";
    if (!txHash) throw new Error("Transfer failed: no txHash returned");
    return txHash;
  }

  async approveEscrow(params: { walletId: string; amount: string }): Promise<string> {
    const escrowAddress = CONTRACT_ADDRESSES.contracts?.OrchestratorEscrow;
    if (!escrowAddress) throw new Error("Escrow address not found");
    const amountWei = BigInt(Math.floor(parseFloat(params.amount) * 1_000_000)).toString();
    const response = await this.client.createContractExecutionTransaction({
      walletId: params.walletId,
      contractAddress: CONTRACT_ADDRESSES.contracts?.USDC,
      abiFunctionSignature: "approve(address,uint256)",
      abiParameters: [escrowAddress, amountWei],
      fee: { type: "level", config: { feeLevel: "MEDIUM" } },
    });
    const txData = response.data as any;
    return txData?.transaction?.txHash ?? txData?.txHash ?? "";
  }

  async waitForTransaction(txHash: string, maxWaitMs = 30000): Promise<boolean> {
    const start = Date.now();
    const publicClient = createPublicClient({
      chain: arcTestnet,
      transport: http(),
    });
    while (Date.now() - start < maxWaitMs) {
      try {
        const receipt = await publicClient.getTransactionReceipt({
          hash: txHash as `0x${string}`,
        });
        if (receipt) return receipt.status === "success";
      } catch {}
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async requestTestnetFunds(address: string): Promise<void> {
    try {
      await this.client.requestTestnetTokens({
        address,
        blockchain: "EVM-TESTNET",
        native: false,
        usdc: true,
      });
    } catch {}
  }

  async getWallet(walletId: string) {
    const response = await this.client.getWallet({ id: walletId });
    return response.data?.wallet;
  }
}

export const circleWalletService = new CircleWalletService();