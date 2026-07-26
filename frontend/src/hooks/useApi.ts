import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount, useSignMessage } from "wagmi";
import type { Task, AgentProfile, WSEvent } from "../types";

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

  const createTask = useCallback(async (params: { description: string; budget: number }) => {
    if (!address || !chainId) throw new Error("Wallet not connected or invalid network");

    const message = createSiweMessage(address, "Create a new task", chainId);
    const signature = await signMessageAsync({ message });

    const task = await apiFetch<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify({ ...params, requesterAddress: address, message, signature }),
    });
    
    // Prepend the new task to the list immediately for snappy UI
    setTasks((prev) => [task, ...prev]);
    return task;
  }, [address, chainId, signMessageAsync]);

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