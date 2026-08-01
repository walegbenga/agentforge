import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useSignMessage, useWriteContract, usePublicClient } from "wagmi";
import { decodeEventLog } from "viem";
import type { Task, AgentProfile, WSEvent } from "../types";
import { CONTRACTS, USDC_ABI, ESCROW_ABI, arcTestnet } from "../config/wagmi";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const WS_URL = import.meta.env.VITE_WS_URL || `ws://localhost:3001/ws`;

const createSiweMessage = (address: string, action: string, chainId: number) => {
  const domain = window.location.hostname;
  const origin = window.location.origin;
  const issuedAt = new Date().toISOString();
  const nonce = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  
  return `${domain} wants you to sign in with your Ethereum account:
${address}

${action}

URI: ${origin}
Version: 1
Chain ID: ${chainId}
Nonce: ${nonce}
Issued At: ${issuedAt}`;
};

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "API error");
  return json.data as T;
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export function useTasks() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const { address, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: arcTestnet.id });

  const load = useCallback(async () => {
    // ✅ FIX: If no address, clear data and stop. Do NOT fetch global tasks.
    if (!address) {
      setTasks([]);
      setLoading(false);
      return;
    }

    setLoading(true); // ✅ Show loading state while switching wallets
    try {
      // ✅ FIX: ALWAYS enforce the address filter when connected
      const data = await apiFetch<Task[]>(`/tasks?address=${address}`);
      setTasks(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { load(); }, [load]);

  /**
   * Real payment flow: the user's own wallet pays USDC into escrow.
   * Steps (each is a separate wallet prompt, reported via onProgress):
   *   1. approve() — only if current allowance is insufficient
   *   2. createTask() on the escrow contract — this is the actual transfer
   *   3. register the resulting on-chain task with the backend (SIWE-signed
   *      for identity, not payment — the payment already happened above)
   *
   * Previously this only signed an off-chain SIWE message, so no USDC ever
   * actually left the user's wallet — the backend's own operator wallet was
   * silently funding every task instead.
   */
  const createTask = useCallback(async (
    params: { description: string; budget: number },
    onProgress?: (step: "approving" | "locking" | "confirming" | "registering") => void
  ) => {
    if (!address || !chainId) throw new Error("Wallet not connected or invalid network");
    if (!publicClient) throw new Error("No RPC connection available");

    const budget = BigInt(params.budget);

    const allowance = (await publicClient.readContract({
      address: CONTRACTS.USDC,
      abi: USDC_ABI,
      functionName: "allowance",
      args: [address, CONTRACTS.OrchestratorEscrow],
    })) as bigint;

    if (allowance < budget) {
      onProgress?.("approving");
      const approveHash = await writeContractAsync({
        address: CONTRACTS.USDC,
        abi: USDC_ABI,
        functionName: "approve",
        args: [CONTRACTS.OrchestratorEscrow, budget],
        chainId: arcTestnet.id,
      });
      await publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    onProgress?.("locking");
    const createHash = await writeContractAsync({
      address: CONTRACTS.OrchestratorEscrow,
      abi: ESCROW_ABI,
      functionName: "createTask",
      args: [params.description, budget],
      chainId: arcTestnet.id,
    });

    onProgress?.("confirming");
    const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash });

    let onChainTaskId: string | null = null;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({ abi: ESCROW_ABI, data: log.data, topics: log.topics });
        if (decoded.eventName === "TaskCreated") {
          onChainTaskId = (decoded.args as { taskId: bigint }).taskId.toString();
          break;
        }
      } catch {
        // not the event we're looking for, ignore
      }
    }
    if (!onChainTaskId) {
      throw new Error("Budget was locked on-chain, but the task ID couldn't be read back from the transaction. Check the explorer and contact support before retrying — do not resubmit blindly.");
    }

    onProgress?.("registering");
    const message = createSiweMessage(address, "Create a new task", chainId);
    const signature = await signMessageAsync({ message });

    const task = await apiFetch<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify({
        ...params,
        requesterAddress: address,
        message,
        signature,
        onChainTaskId,
        createTaskTxHash: createHash,
      }),
    });

    // Prepend the new task to the list immediately for snappy UI
    setTasks((prev) => [task, ...prev]);
    return task;
  }, [address, chainId, signMessageAsync, writeContractAsync, publicClient]);

  const updateTask = useCallback((updated: Task) => {
    setTasks((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
  }, []);

  return { tasks, loading, createTask, updateTask, refresh: load };
}

export function useClaimSubtask() {
  const { address, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const claim = useCallback(async (taskId: string, subtaskIndex: number) => {
    if (!address || !chainId) throw new Error("Wallet not connected or invalid network");
    const message = createSiweMessage(address, "Claim a subtask", chainId);
    const signature = await signMessageAsync({ message });

    return apiFetch<Task>(`/tasks/${taskId}/claim`, {
      method: "POST",
      body: JSON.stringify({ walletAddress: address, subtaskIndex, message, signature }),
    });
  }, [address, chainId, signMessageAsync]);

  return { claim };
}

export function useRegisterAgent() {
  const { address, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();

  const register = useCallback(async (params: { name: string; description: string; capabilities: string[]; pricePerTask: number }) => {
    if (!address || !chainId) throw new Error("Wallet not connected or invalid network");
    const message = createSiweMessage(address, "Register as an AI Agent", chainId);
    const signature = await signMessageAsync({ message });

    return apiFetch<AgentProfile>("/agents", {
      method: "POST",
      body: JSON.stringify({ ...params, walletAddress: address, message, signature }),
    });
  }, [address, chainId, signMessageAsync]);

  return { register };
}

export function useDemoTask() {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // No address query param = public "all tasks" endpoint (see backend
        // GET /tasks). Used to find a real completed task to replay for
        // visitors who haven't connected a wallet yet.
        const tasks = await apiFetch<Task[]>("/tasks");
        const completed = tasks
          .filter((t) => t.status === "completed" && t.subtasks?.length > 0 && t.orchestrationLog?.length > 0)
          .sort(
            (a, b) =>
              new Date(b.completedAt || b.createdAt).getTime() -
              new Date(a.completedAt || a.createdAt).getTime()
          );
        if (!cancelled) setTask(completed[0] || null);
      } catch (err) {
        console.error("Failed to load demo task:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { task, loading };
}

export function useTask(taskId: string | null) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!taskId) return;
    setLoading(true);
    apiFetch<Task>(`/tasks/${taskId}`).then(setTask).catch(console.error).finally(() => setLoading(false));
  }, [taskId]);
  const refresh = useCallback(async () => {
    if (!taskId) return;
    const data = await apiFetch<Task>(`/tasks/${taskId}`);
    setTask(data);
  }, [taskId]);
  return { task, loading, setTask, refresh };
}

export function useAgents() {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const { address } = useAccount();

  useEffect(() => {
    if (!address) { setAgents([]); setLoading(false); return; }
    apiFetch<AgentProfile[]>("/agents")
      .then((allAgents) => {
        // ✅ FIX: Only keep the agent belonging to the connected wallet
        const myAgent = allAgents.find(a => a.walletAddress.toLowerCase() === address.toLowerCase());
        setAgents(myAgent ? [myAgent] : []);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [address]);

  return { agents, loading };
}

export function useStats() {
  const [stats, setStats] = useState<any>(null);
  const load = useCallback(async () => {
    try { const data = await apiFetch<any>("/stats"); setStats(data); } catch {}
  }, []);
  useEffect(() => { load(); const interval = setInterval(load, 30_000); return () => clearInterval(interval); }, [load]);
  return { stats, refresh: load };
}

export function useMyStats() {
  const { address } = useAccount();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) { setStats(null); setLoading(false); return; }
    const fetchStats = async () => {
      setLoading(true);
      try { const data = await apiFetch<any>(`/stats/me?address=${address}`); setStats(data); } 
      catch (err) { console.error("Failed to fetch user stats:", err); } 
      finally { setLoading(false); }
    };
    fetchStats();
  }, [address]);

  return { stats, loading };
}

export function useWebSocket(onEvent: (event: WSEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  useEffect(() => {
    let reconnectTimeout: ReturnType<typeof setTimeout>;
    let attempts = 0;
    function connect() {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onmessage = (msg) => { try { const event = JSON.parse(msg.data) as WSEvent; onEventRef.current(event); } catch {} };
      ws.onopen = () => { attempts = 0; };
      ws.onclose = () => { attempts++; const delay = Math.min(1000 * attempts, 10000); reconnectTimeout = setTimeout(connect, delay); };
      ws.onerror = () => ws.close();
    }
    connect();
    return () => { clearTimeout(reconnectTimeout); wsRef.current?.close(); };
  }, []);
  return wsRef;
}