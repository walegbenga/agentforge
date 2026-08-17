import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { defineChain } from "viem";

// ── RPC Proxy ──────────────────────────────────────────────────────────────
// The real Arc RPC URL (with its Alchemy API key) now lives only in the
// backend's environment (ARC_RPC_URL) and is proxied via /rpc — see
// backend/src/routes/rpc.routes.ts. It used to be hardcoded directly here,
// which meant the key shipped in the public JS bundle for anyone to pull
// out of devtools.
//
// This has to resolve to an ABSOLUTE url (not "/rpc") because MetaMask
// itself — not just our own app's fetch calls — talks to this URL directly
// once a chain is added via wallet_addEthereumChain, and a relative path
// means nothing outside our own app's origin.
const RAW_API_BASE = import.meta.env.VITE_API_URL || "/api";
const API_ORIGIN = /^https?:\/\//i.test(RAW_API_BASE)
  ? RAW_API_BASE.replace(/\/api\/?$/, "")
  : typeof window !== "undefined"
    ? window.location.origin
    : "";
export const RPC_PROXY_URL = `${API_ORIGIN}/rpc`;

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
    default: { http: [RPC_PROXY_URL] },
    public: { http: [RPC_PROXY_URL] },
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
  AgentCapabilityRegistry: "0xA804fdA286799417326Ce74D57A2054aB4eBc2D8" as `0x${string}`,
  OrchestratorEscrow: "0x75A4f48Ca4C3a74c0760ecdad9135409325D0C53" as `0x${string}`,
};

// ── Wagmi Config ──────────────────────────────────────────────────────────────

export const wagmiConfig = getDefaultConfig({
  appName: "ForgeOps AI",
  projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID || "forgeops-hackathon",
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
  {
    name: "TaskCreated",
    type: "event",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "requester", type: "address", indexed: true },
      { name: "budget", type: "uint256", indexed: false },
    ],
  },
  {
    name: "ServiceFeeCharged",
    type: "event",
    inputs: [
      { name: "taskId", type: "uint256", indexed: true },
      { name: "grossBudget", type: "uint256", indexed: false },
      { name: "serviceFee", type: "uint256", indexed: false },
      { name: "netBudget", type: "uint256", indexed: false },
    ],
  },
] as const;