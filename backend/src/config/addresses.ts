import { readFileSync, existsSync } from "fs";
import { join } from "path";

// Hardcoded fallback — always works regardless of file system
const HARDCODED = {
  network: "arcTestnet",
  chainId: 5042002,
  contracts: {
    AgentCapabilityRegistry: "0xc749a117C3222Fee7a000161c01756EEFb027981",
    OrchestratorEscrow: "0x4ca8EdA765c2d768d0b0FDe277bf2b973989246c",
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