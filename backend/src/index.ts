import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

// Load env — works on both Windows (local) and Linux (Railway)
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../.env") });
config({ path: join(process.cwd(), ".env") });

console.log("ENV CHECK:");
console.log("  ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✓ loaded" : "✗ missing");
console.log("  CIRCLE_API_KEY:", process.env.CIRCLE_API_KEY ? "✓ loaded" : "✗ missing");
console.log("  DEPLOYER_PRIVATE_KEY:", process.env.DEPLOYER_PRIVATE_KEY ? "✓ loaded" : "✗ missing");

import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = "0.0.0.0";

// ── CORS — allow Vercel frontend ───────────────────────────────────────────
const allowedOrigins = [
  "https://agentforged.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  process.env.FRONTEND_URL,
].filter(Boolean) as string[];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

app.use(express.json());
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // max 50 requests per IP
  message: { success: false, error: "Too many requests" },
});

app.use("/api", limiter);

// ── Health check — responds immediately ────────────────────────────────────
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

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