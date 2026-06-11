import { config } from "dotenv";

// Load env BEFORE anything else
config({ path: "C:\\Users\\User\\Desktop\\agent\\.env" });

// Verify keys loaded
console.log("ENV CHECK:");
console.log("  ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✓ loaded" : "✗ missing");
console.log("  CIRCLE_API_KEY:", process.env.CIRCLE_API_KEY ? "✓ loaded" : "✗ missing");
console.log("  DEPLOYER_PRIVATE_KEY:", process.env.DEPLOYER_PRIVATE_KEY ? "✓ loaded" : "✗ missing");

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);

app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

async function start() {
  // Dynamic imports AFTER env is loaded
  const { wsService } = await import("./services/websocket.service.js");
  const { agentRegistry } = await import("./services/agentRegistry.service.js");
  const { default: apiRoutes } = await import("./routes/api.routes.js");

  wsService.initialize(wss);
  app.use("/api", apiRoutes);

  console.log("\n╔═══════════════════════════════╗");
  console.log("║     AgentForge Backend        ║");
  console.log("╚═══════════════════════════════╝\n");

  server.listen(PORT, () => {
    console.log(`✓ HTTP  → http://localhost:${PORT}/api`);
    console.log(`✓ WS    → ws://localhost:${PORT}/ws`);
    console.log(`✓ Ready\n`);
  });

  agentRegistry.initialize().catch((err) => {
    console.warn("Agent registry init warning:", err.message);
  });
}

start().catch(console.error);