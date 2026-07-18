import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load env — works on both Windows (local) and Linux (Railway)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../.env") });           // local dev
config({ path: join(process.cwd(), ".env") });             // fallback

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
const HOST = "0.0.0.0"; // Required for Railway — localhost won't work

app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

async function start() {
  const { wsService } = await import("./services/websocket.service.js");
  const { agentRegistry } = await import("./services/agentRegistry.service.js");
  const { default: apiRoutes } = await import("./routes/api.routes.js");

  wsService.initialize(wss);
  app.use("/api", apiRoutes);

  console.log("\n╔═══════════════════════════════╗");
  console.log("║     AgentForge Backend        ║");
  console.log("╚═══════════════════════════════╝\n");

  // Bind to 0.0.0.0 so Railway can route external traffic
  server.listen(PORT, HOST, () => {
    console.log(`✓ HTTP  → http://${HOST}:${PORT}/api`);
    console.log(`✓ WS    → ws://${HOST}:${PORT}/ws`);
    console.log(`✓ Ready\n`);
  });

  agentRegistry.initialize().catch((err) => {
    console.warn("Agent registry init warning:", err.message);
  });
}

start().catch(console.error);