import { useState, useEffect, useCallback, useRef } from "react";
import { useAccount } from "wagmi";
import type { Task, AgentProfile, WSEvent } from "../types";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const WS_URL = import.meta.env.VITE_WS_URL || `ws://localhost:3001/ws`;

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
  const { address } = useAccount();

  const load = useCallback(async () => {
    try {
      const url = address ? `/tasks?address=${address}` : "/tasks";
      const data = await apiFetch<Task[]>(url);
      setTasks(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => { load(); }, [load]);

  const createTask = useCallback(async (params: {
    description: string;
    budget: number;
    requesterAddress: string;
  }) => {
    const task = await apiFetch<Task>("/tasks", {
      method: "POST",
      body: JSON.stringify(params),
    });
    setTasks((prev) => [task, ...prev]);
    return task;
  }, []);

  const updateTask = useCallback((updated: Task) => {
    setTasks((prev) => prev.map((t) => t.id === updated.id ? { ...t, ...updated } : t));
  }, []);

  return { tasks, loading, createTask, updateTask, refresh: load };
}

export function useTask(taskId: string | null) {
  const [task, setTask] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    setLoading(true);
    apiFetch<Task>(`/tasks/${taskId}`)
      .then(setTask)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [taskId]);

  const refresh = useCallback(async () => {
    if (!taskId) return;
    const data = await apiFetch<Task>(`/tasks/${taskId}`);
    setTask(data);
  }, [taskId]);

  return { task, loading, setTask, refresh };
}

// ── Agents ─────────────────────────────────────────────────────────────────────

export function useAgents() {
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    apiFetch<AgentProfile[]>("/agents")
      .then(setAgents)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return { agents, loading };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export function useStats() {
  const [stats, setStats] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<any>("/stats");
      setStats(data);
    } catch {}
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return { stats, refresh: load };
}

// ✅ NEW: Server-side user-specific stats hook
export function useMyStats() {
  const { address } = useAccount();
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!address) {
      setStats(null);
      setLoading(false);
      return;
    }

    const fetchStats = async () => {
      setLoading(true);
      try {
        const data = await apiFetch<any>(`/stats/me?address=${address}`);
        setStats(data);
      } catch (err) {
        console.error("Failed to fetch user stats:", err);
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [address]);

  return { stats, loading };
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

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

      ws.onmessage = (msg) => {
        try {
          const event = JSON.parse(msg.data) as WSEvent;
          onEventRef.current(event);
        } catch {}
      };

      ws.onopen = () => {
        attempts = 0;
      };

      ws.onclose = () => {
        attempts++;
        const delay = Math.min(1000 * attempts, 10000);
        reconnectTimeout = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    }

    connect();

    return () => {
      clearTimeout(reconnectTimeout);
      wsRef.current?.close();
    };
  }, []);

  return wsRef;
}