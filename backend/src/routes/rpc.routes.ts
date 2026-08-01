import { Router, Request, Response } from "express";

const router = Router();

// The real RPC URL (with API key) lives ONLY in this server's environment.
// Previously this exact URL was hardcoded directly in frontend source
// (frontend/src/config/wagmi.ts), which meant it shipped in the public JS
// bundle for anyone to extract from devtools. Wagmi/viem now point at this
// proxy instead — see arcTestnet.rpcUrls in wagmi.ts.
const ARC_RPC_URL = process.env.ARC_RPC_URL;

router.post("/", async (req: Request, res: Response) => {
  if (!ARC_RPC_URL) {
    res.status(500).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32000, message: "RPC proxy not configured on the server (ARC_RPC_URL missing)" },
    });
    return;
  }

  try {
    const upstream = await fetch(ARC_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err: any) {
    res.status(502).json({
      jsonrpc: "2.0",
      id: req.body?.id ?? null,
      error: { code: -32003, message: `RPC proxy request failed: ${err.message}` },
    });
  }
});

export default router;