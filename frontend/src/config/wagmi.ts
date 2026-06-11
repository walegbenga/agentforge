import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { defineChain } from "viem";

// ── Arc Testnet Chain Definition ──────────────────────────────────────────────

export const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: {
    name: "USDC",
    symbol: "USDC",
    decimals: 6,
  },
  rpcUrls: {
    default: { http: ["https://rpc.testnet.arc.network"] },
    public: { http: ["https://rpc.testnet.arc.network"] },
  },
  blockExplorers: {
    default: {
      name: "Arc Explorer",
      url: "https://explorer.testnet.arc.network",
    },
  },
  testnet: true,
});

// ── Contract Addresses ────────────────────────────────────────────────────────

export const CONTRACTS = {
  USDC: "0x3600000000000000000000000000000000000000" as `0x${string}`,
  AgentCapabilityRegistry: "" as `0x${string}`, // loaded from addresses.json at runtime
  OrchestratorEscrow: "" as `0x${string}`,
};

// ── Wagmi Config ──────────────────────────────────────────────────────────────

export const wagmiConfig = getDefaultConfig({
  appName: "AgentForge",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "agentforge-hackathon",
  chains: [arcTestnet],
  ssr: false,
});

// ── USDC ABI (minimal) ────────────────────────────────────────────────────────

export const USDC_ABI = [
  {
    name: "approve",
    type: "function",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

// ── Escrow ABI (minimal) ──────────────────────────────────────────────────────

export const ESCROW_ABI = [
  {
    name: "createTask",
    type: "function",
    inputs: [
      { name: "description", type: "string" },
      { name: "budget", type: "uint256" },
    ],
    outputs: [{ name: "taskId", type: "uint256" }],
  },
] as const;
