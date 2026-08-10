import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";
dotenv.config({ path: "../.env" });

// Arc Testnet USDC contract address
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance (USDC):", ethers.formatUnits(balance, 6));

  // Additional operator wallets to grant ORCHESTRATOR_ROLE at deploy time —
  // this is what lets multiple backend signers submit assign/settle/
  // dispute/complete transactions in parallel instead of a single
  // wallet's sequential nonce being the ceiling on platform throughput.
  // The deployer itself is always granted the role too, so a single-signer
  // setup still works out of the box with zero extra config.
  const extraOrchestrators = (process.env.ORCHESTRATOR_ADDRESSES || "")
    .split(",")
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
  if (extraOrchestrators.length > 0) {
    console.log("\n→ Granting ORCHESTRATOR_ROLE at deploy time to:", extraOrchestrators);
  } else {
    console.log("\n⚠  No ORCHESTRATOR_ADDRESSES set — only the deployer wallet will hold ORCHESTRATOR_ROLE. Grant more later with grantRole() to scale signing across multiple wallets.");
  }

  // 1. Deploy AgentCapabilityRegistry
  console.log("\n→ Deploying AgentCapabilityRegistry...");
  const Registry = await ethers.getContractFactory("AgentCapabilityRegistry");
  const registry = await Registry.deploy();
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("  AgentCapabilityRegistry:", registryAddress);

  // 2. Deploy OrchestratorEscrow
  console.log("\n→ Deploying OrchestratorEscrow...");
  const Escrow = await ethers.getContractFactory("OrchestratorEscrow");
  const escrow = await Escrow.deploy(
    USDC_ARC_TESTNET,
    registryAddress,
    deployer.address, // fee recipient (update to multisig in production)
    extraOrchestrators
  );
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("  OrchestratorEscrow:", escrowAddress);

  // Save addresses for backend/frontend
  const addresses = {
    network: "arcTestnet",
    chainId: 5042002,
    deployedAt: new Date().toISOString(),
    contracts: {
      AgentCapabilityRegistry: registryAddress,
      OrchestratorEscrow: escrowAddress,
      USDC: USDC_ARC_TESTNET,
    },
    orchestratorWallets: [deployer.address, ...extraOrchestrators],
    // Arc native ERC-8004 / ERC-8183 contracts
    arc: {
      IdentityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
      ReputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
      ValidationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272",
      AgenticCommerce:    "0x0747EEf0706327138c69792bF28Cd525089e4583",
    }
  };

  const outPath = path.join(__dirname, "../../addresses.json");
  fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
  console.log("\n✓ Addresses saved to addresses.json");
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});