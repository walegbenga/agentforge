import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Hardcoded fallback — always works regardless of file system
// ⚠️ MUST BE UPDATED after redeploying OrchestratorEscrow (e.g. for the
// AccessControl/multi-signer upgrade) — this address is only correct for
// the OLD single-owner contract. addresses.json (written fresh by
// contracts/scripts/deploy.ts on every deploy) takes priority over this
// and will be correct automatically; this is only a silent trap if that
// file is ever missing on a given deployment.
const HARDCODED = {
  network: "arcTestnet",
  chainId: 5042002,
  contracts: {
    AgentCapabilityRegistry: "0xA804fdA286799417326Ce74D57A2054aB4eBc2D8",
    OrchestratorEscrow: "0x75A4f48Ca4C3a74c0760ecdad9135409325D0C53",
    USDC: "0x3600000000000000000000000000000000000000",
  },
  arc: {
    IdentityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    ReputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    ValidationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
    AgenticCommerce: "0x0747EEf0706327138c69792bF28Cd525089e4583",
  },
};

function load(): typeof HARDCODED {
  // 1. Railway env var
  if (process.env.CONTRACT_ADDRESSES) {
    try {
      return JSON.parse(process.env.CONTRACT_ADDRESSES);
    } catch {}
  }

  // 2. Try multiple file paths for local dev
  const candidates = [
    join(process.cwd(), "addresses.json"),
    join(process.cwd(), "backend/addresses.json"),
    join(process.cwd(), "../addresses.json"),
    "/app/addresses.json",
    "/app/backend/addresses.json",
  ];

  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        console.log(`✓ Loaded addresses from ${p}`);
        return JSON.parse(readFileSync(p, "utf-8"));
      }
    } catch {}
  }

  // 3. Hardcoded fallback
  console.log("ℹ Using hardcoded contract addresses (deployment mode)");
  return HARDCODED;
}

export const addresses = load();
export const CONTRACT_ADDRESSES = addresses;