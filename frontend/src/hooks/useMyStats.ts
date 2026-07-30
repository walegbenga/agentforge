import { useState, useEffect, useCallback } from "react";
import { useAccount } from "wagmi";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

async function apiFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error || "API error");
  return json.data as T;
}

export function useMyStats() {
  const [stats, setStats] = useState<any>(null);
  const { address } = useAccount();

  const load = useCallback(async () => {
    if (!address) return;
    try {
      const tasks = await apiFetch<any[]>(`/tasks?address=${address}`);
      const completedTasks = tasks.filter((t: any) => t.status === "completed").length;
      const totalVolume = tasks.reduce((s: number, t: any) => s + t.totalBudget, 0);
      setStats({ completedTasks, totalVolume, totalTasks: tasks.length });
    } catch (err) {
      console.error("Failed to load stats", err);
    }
  }, [address]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  return { stats, refresh: load };
}