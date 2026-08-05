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
    if (!address) {
      // ✅ FIX: previously this just returned early, leaving the PREVIOUS
      // wallet's stats displayed indefinitely after disconnecting — this
      // is exactly the "shows the last wallet's data" symptom.
      setStats(null);
      return;
    }
    try {
      // ✅ FIX: was fetching /tasks?address=... and computing totals by
      // counting the returned array — now that /tasks paginates (10 per
      // page by default), that undercounted anyone with more than 10
      // tasks. /stats/me already existed as a correct, non-paginated
      // aggregate and was just never wired up here.
      const data = await apiFetch<{ completedTasks: number; totalVolume: number; agents: number; jobsCompleted: number }>(
        `/stats/me?address=${address}`
      );
      setStats({ completedTasks: data.completedTasks, totalVolume: data.totalVolume });
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