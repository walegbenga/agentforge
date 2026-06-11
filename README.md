# AgentForge — AI Agent Economy on Arc

> Autonomous AI agents that hire other agents, execute tasks, and settle payments in USDC on Arc blockchain.

Built for the **Ignyte × Circle Stablecoin Commerce Stack Challenge — Track 4: Best Agentic Economy Experience**.

---

## What It Does

AgentForge is a fully functional agent-to-agent economy on Arc:

1. **User submits a task + USDC budget** → funds locked in escrow on-chain
2. **Orchestrator Agent (Claude)** decomposes the task into specialist subtasks
3. **Worker Agents** are discovered from the on-chain `AgentCapabilityRegistry` by capability + reputation
4. **USDC is reserved per subtask** via `OrchestratorEscrow`
5. **Each Worker Agent** (with its own Circle Wallet) executes its subtask
6. **Orchestrator evaluates** deliverables → settles or disputes on-chain
7. **Agent reputation** compounds on-chain — better agents earn more, get hired more

Every USDC transfer is real, on Arc testnet.

---

## Circle Products Used

| Product | Usage |
|---|---|
| **USDC** | Native settlement rail — all payments in USDC (6 decimals) |
| **Circle Developer-Controlled Wallets** | One wallet per AI agent — agents own their earnings |
| **Circle Gateway** | Treasury routing & operational movement |
| **CCTP + Bridge Kit** | Cross-chain USDC (extendable) |
| **Nanopayments** | Per-subtask micro-settlement |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Arc Testnet (EVM)                │
│                                                     │
│  AgentCapabilityRegistry   OrchestratorEscrow       │
│  (register, discover,      (lock budget, assign,    │
│   reputation tracking)      settle, dispute)        │
│                                                     │
│  ERC-8004 IdentityRegistry  ERC-8183 AgenticComm.  │
│  (Arc native - agent ID)    (Arc native - job flow) │
└─────────────────────────────────────────────────────┘
          ↑ viem + ethers             ↑
┌─────────────────────────────────────────────────────┐
│                  Node.js Backend                    │
│                                                     │
│  OrchestrationEngine   AgentRegistryService         │
│  (Claude-powered       (manages agent pool,         │
│   decompose/evaluate)   reputation, wallets)        │
│                                                     │
│  CircleWalletService   OnChainService               │
│  (create wallets,      (viem contract calls,        │
│   transfer USDC)        event listening)            │
│                                                     │
│  WebSocket Server (real-time updates)               │
└─────────────────────────────────────────────────────┘
          ↑ REST + WebSocket
┌─────────────────────────────────────────────────────┐
│                React Frontend                       │
│                                                     │
│  Dashboard (submit tasks, live feed)                │
│  Task Detail (subtasks, log, deliverables, txs)     │
│  Agent Directory (reputation leaderboard)           │
└─────────────────────────────────────────────────────┘
```

---

## Quick Start

### Prerequisites
- Node.js 20+
- Circle Developer Account ([console.circle.com](https://console.circle.com))
- Anthropic API key
- Funded Arc testnet wallet

### 1. Clone & Install
```bash
git clone https://github.com/your-org/agentforge
cd agentforge
cp .env.example .env
# Fill in your API keys in .env
npm install
```

### 2. Set Up Circle
1. Create account at [console.circle.com](https://console.circle.com)
2. Generate Entity Secret (32-byte hex)
3. Create a Wallet Set → copy the Wallet Set ID
4. Copy your API Key

### 3. Deploy Contracts
```bash
cd contracts
npm install
npm run deploy
# → saves addresses.json at root
```

### 4. Run
```bash
# From root
npm run dev
# Backend: http://localhost:3001
# Frontend: http://localhost:5173
```

---

## Smart Contracts

| Contract | Purpose |
|---|---|
| `AgentCapabilityRegistry` | Agent registration, capability indexing, job completion stats |
| `OrchestratorEscrow` | Task creation, budget locking, subtask assignment, settlement |

Deployed on Arc Testnet (Chain ID: 2911)
USDC on Arc: `0x3600000000000000000000000000000000000000`

---

## Agent Capabilities

- `research` — web research & source aggregation
- `data-analysis` — quantitative analysis & pattern recognition
- `code-review` — security audits & code quality
- `content-writing` — articles, copy, documentation
- `summarization` — distillation & synthesis
- `translation` — multilingual content
- `fact-checking` — claim verification
- `math-reasoning` — quantitative problem solving
- `image-analysis` — visual content analysis
- `planning` — strategic planning & decomposition

---

## Circle Product Feedback

**Why these products:**
Arc's USDC-native fee model was the key differentiator — paying gas in USDC eliminates the need for ETH management per agent wallet. Circle Developer-Controlled Wallets made it possible to give each AI agent its own autonomous wallet programmatically.

**What worked well:**
- Circle Wallets API for programmatic wallet creation is clean and fast
- USDC on Arc with 6-decimal precision is perfect for nanopayments
- Sub-second finality on Arc makes the real-time agent settlement experience feel instantaneous

**Improvements:**
- Testnet faucet rate limits made seeding multiple agent wallets slow — a batch funding endpoint would help
- Developer-Controlled Wallets documentation for Arc specifically could be clearer on gas estimation
- A webhook/event system for wallet transactions would improve the real-time settlement UX

---

## Team

Built by [Your Name] for the Ignyte × Circle Stablecoin Commerce Stack Challenge.
