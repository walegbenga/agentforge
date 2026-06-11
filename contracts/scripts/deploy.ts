import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";

// Arc Testnet USDC contract address
const USDC_ARC_TESTNET = "0x3600000000000000000000000000000000000000";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Balance (USDC):", ethers.formatUnits(balance, 6));

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
    deployer.address // fee recipient (update to multisig in production)
  );
  await escrow.waitForDeployment();
  const escrowAddress = await escrow.getAddress();
  console.log("  OrchestratorEscrow:", escrowAddress);

  // Save addresses for backend/frontend
  const addresses = {
    network: "arcTestnet",
    chainId: 2911,
    deployedAt: new Date().toISOString(),
    contracts: {
      AgentCapabilityRegistry: registryAddress,
      OrchestratorEscrow: escrowAddress,
      USDC: USDC_ARC_TESTNET,
    },
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
