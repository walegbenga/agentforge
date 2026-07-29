import { config } from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import rateLimit from "express-rate-limit"; // ✅ Added Rate Limiting

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, "../../.env") });
config({ path: join(process.cwd(), ".env") });

console.log("ENV CHECK:");
console.log("  ANTHROPIC_API_KEY:", process.env.ANTHROPIC_API_KEY ? "✓ loaded" : "✗ missing");
console.log("  CIRCLE_API_KEY:", process.env.CIRCLE_API_KEY ? "✓ loaded" : "✗ missing");
console.log("  DEPLOYER_PRIVATE_KEY:", process.env.DEPLOYER_PRIVATE_KEY ? "✓ loaded" : "✗ missing");
console.log("  DATABASE_URL:", process.env.DATABASE_URL ? "✓ loaded" : "✗ missing");

import express from "express";
import cors from "cors";
import { createServer } from "http";
import { WebSocketServer } from "ws";
import { connectDB, disconnectDB } from "./services/db.service.js";

const app = express();
const PORT = parseInt(process.env.PORT || "3001", 10);
const HOST = "0.0.0.0";

const allowedOrigins = [
  "https://agentforge-gules.vercel.app", // ✅ Updated to your actual Vercel URL
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

// ✅ NEW: Global Rate Limiter (100 requests per 15 minutes per IP)
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  message: { success: false, error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all /api routes
app.use("/api", apiLimiter);

// Health check — responds immediately
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

  // Start the background worker
  const { taskWorker } = await import("./services/taskQueue.service.js");
  console.log("✓ Background Task Worker Started (BullMQ)");

async function start() {
  await connectDB();

  const { wsService } = await import("./services/websocket.service.js");
  const { default: apiRoutes } = await import("./routes/api.routes.js");

  wsService.initialize(wss);
  app.use("/api", apiRoutes);

  console.log("\n╔═══════════════════════════════╗");
  console.log("║        ForgeOps AI            ║");
  console.log("║  Multi-Agent Automation       ║");
  console.log("╚═══════════════════════════════╝\n");

  server.listen(PORT, HOST, () => {
    console.log(`✓ HTTP  → http://${HOST}:${PORT}/api`);
    console.log(`✓ WS    → ws://${HOST}:${PORT}/ws`);
    console.log(`✓ Ready\n`);
  });

  process.on("SIGTERM", async () => {
    console.log("SIGTERM received — shutting down gracefully");
    server.close();
    await disconnectDB();
    process.exit(0);
  });
}

start().catch(console.error);