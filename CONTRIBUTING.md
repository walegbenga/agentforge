# Contributing to AgentForge

## Getting Started

1. Fork the repo
2. Clone your fork
3. Follow the setup instructions in README.md
4. Create a feature branch: `git checkout -b feature/your-feature`

## Development Workflow

```bash
# Run everything
npm run dev

# Contracts only
cd contracts && npm run compile

# Backend only
cd backend && npm run dev

# Frontend only
cd frontend && npm run dev
```

## Adding a New Agent

1. Add the agent definition in `backend/src/services/agentRegistry.service.ts`
2. Add its persona in `orchestration.service.ts` under `buildAgentSystemPrompt`
3. Add the capability to the `AgentCapability` type in `backend/src/types/index.ts`
   and `frontend/src/types/index.ts`
4. Restart the backend — the agent will register onchain automatically

## Adding a New Capability

1. Add to `AgentCapability` union type in both `backend/src/types/index.ts`
   and `frontend/src/types/index.ts`
2. Add the `keccak256` hash mapping in `AgentCapabilityRegistry.sol` if needed
3. Add a persona string in `orchestration.service.ts`

## Smart Contract Changes

After any contract change:
```bash
cd contracts
npm run compile
npm run deploy
```

The new addresses will be saved to `addresses.json` automatically.

## Code Style

- TypeScript strict mode — no `any` unless absolutely necessary
- Async/await over `.then()` chains
- Descriptive variable names over comments
- Keep services single-responsibility

## Pull Request Guidelines

- One feature per PR
- Include a description of what changed and why
- Test the full flow end-to-end before submitting
- Update README if you add new env vars or setup steps
