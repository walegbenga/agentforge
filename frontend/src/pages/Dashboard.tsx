import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Send, Wallet, TrendingUp, Clock, CheckCircle, DollarSign, ShieldCheck, Loader, Bot, Briefcase } from "lucide-react";
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useTasks, useStats, useAgents, useWebSocket } from "../hooks/useApi";
import TaskCard from "../components/dashboard/TaskCard";
import LiveFeed from "../components/dashboard/LiveFeed";
import { arcTestnet, CONTRACTS, USDC_ABI } from "../config/wagmi";
import type { WSEvent, Task } from "../types";

const ESCROW_ADDRESS = (
  import.meta.env.VITE_ESCROW_ADDRESS || "0x4ca8EdA765c2d768d0b0FDe277bf2b973989246c"
) as `0x${string}`;

const EXAMPLE_TASKS = [
  "Research the top 5 DeFi protocols on Arc blockchain and write a comprehensive comparison report including TVL, unique features, and risks",
  "Analyze the current USDC market cap trends and write a summary with key insights for a crypto investor newsletter",
  "Review this Solidity smart contract for security vulnerabilities and suggest improvements",
  "Create a detailed business plan outline for a UAE-based stablecoin remittance startup targeting expat workers",
];

type SubmitStep =
  | "idle"
  | "checking"
  | "approving"
  | "waiting-approval"
  | "approval-confirmed"
  | "creating-task"
  | "done"
  | "error";

const STEP_LABELS: Record<SubmitStep, string> = {
  idle: "Launch Task",
  checking: "Checking allowance...",
  approving: "Check MetaMask...",
  "waiting-approval": "Confirming approval...",
  "approval-confirmed": "Creating task...",
  "creating-task": "Deploying agents...",
  done: "Done!",
  error: "Try Again",
};

export default function Dashboard() {
  const navigate = useNavigate();
  const { address, isConnected, chainId } = useAccount();
  const { tasks, createTask, updateTask } = useTasks();
  const { agents } = useAgents(); // ✅ Added to calculate local user stats
  const { refresh: refreshStats } = useStats(); // ✅ Kept for WebSocket refresh

  const [description, setDescription] = useState("");
  const [budget, setBudget] = useState(5_000_000);
  const [step, setStep] = useState<SubmitStep>("idle");
  const [error, setError] = useState("");
  const [liveEvents, setLiveEvents] = useState<Array<WSEvent & { id: string }>>([]);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: USDC_ABI,
    functionName: "allowance",
    args: address ? [address, ESCROW_ADDRESS] : undefined,
    query: { 
      enabled: !!address,
      refetchInterval: 30000,
      staleTime: 20000,
    },
  });

  const { data: usdcBalance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { 
      enabled: !!address,
      refetchInterval: 30000,
      staleTime: 20000,
    },
  });

  const {
    writeContract: approveUSDC,
    data: approveTxHash,
    error: approveError,
  } = useWriteContract();

  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: !!approveTxHash },
  });

  useEffect(() => {
    if (approvalConfirmed && step === "waiting-approval") {
      setStep("approval-confirmed");
      refetchAllowance();
      submitTask();
    }
  }, [approvalConfirmed]);

  useEffect(() => {
    if (approveError) {
      setError(
        approveError.message.includes("User rejected")
          ? "Transaction rejected in wallet"
          : approveError.message
      );
      setStep("error");
    }
  }, [approveError]);

  useWebSocket(
    useCallback((event: WSEvent) => {
      if (event.type === "connected") return;
      setLiveEvents((prev) => [
        { ...event, id: `${Date.now()}-${Math.random()}` },
        ...prev.slice(0, 49),
      ]);
      if (event.type === "task:updated") {
        const payload = event.payload as Partial<Task>;
        updateTask({ id: event.taskId, ...payload } as Task);
        refreshStats();
      }
    }, [updateTask, refreshStats])
  );

  const handleSubmit = async () => {
    if (!description.trim() || !address) return;
    setError("");

    const balance = usdcBalance ? BigInt(usdcBalance as bigint) : BigInt(0);
    if (balance < BigInt(budget)) {
      setError(
        `Insufficient USDC. You have $${(Number(balance) / 1_000_000).toFixed(2)}, need $${(budget / 1_000_000).toFixed(2)}`
      );
      setStep("error");
      return;
    }

    setStep("checking");
    const currentAllowance = allowance ? BigInt(allowance as bigint) : BigInt(0);

    if (currentAllowance >= BigInt(budget)) {
      setStep("creating-task");
      await submitTask();
    } else {
      setStep("approving");
      approveUSDC({
        address: CONTRACTS.USDC,
        abi: USDC_ABI,
        functionName: "approve",
        args: [ESCROW_ADDRESS, BigInt(budget)],
        chainId: arcTestnet.id,
      });
      setStep("waiting-approval");
    }
  };

  const submitTask = async () => {
    if (!address || !description.trim()) return;
    setStep("creating-task");
    try {
      const task = await createTask({
        description: description.trim(),
        budget,
        requesterAddress: address,
      });
      setStep("done");
      setDescription("");
      navigate(`/tasks/${task.id}`);
    } catch (err: any) {
      setError(err.message);
      setStep("error");
    }
  };

  const budgetUSDC = (budget / 1_000_000).toFixed(2);
  const balanceUSDC = usdcBalance
    ? (Number(usdcBalance as bigint) / 1_000_000).toFixed(2)
    : "0.00";
  const allowanceUSDC = allowance
    ? (Number(allowance as bigint) / 1_000_000).toFixed(2)
    : "0.00";
  const isAlreadyApproved =
    allowance !== undefined && BigInt(allowance as bigint) >= BigInt(budget);
  const isSubmitting = [
    "checking", "approving", "waiting-approval", "approval-confirmed", "creating-task",
  ].includes(step);
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;

  // ✅ CALCULATE USER-SPECIFIC STATS LOCALLY
  const myAgentsCount = agents ? agents.length : 0;
  const myCompletedTasks = tasks.filter((t: any) => t.status === "completed").length;
  const myTotalVolume = tasks.reduce((sum: number, t: any) => sum + (t.totalBudget || 0), 0);
  const myJobsCompleted = agents ? agents.reduce((sum: number, a: any) => sum + (a.jobsCompleted || 0), 0) : 0;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "1.75rem", letterSpacing: "-0.03em", marginBottom: 4 }}>
          Agent Economy
        </h1>
        <p style={{ color: "var(--text-secondary)", fontSize: "0.875rem" }}>
          Submit a task. AI agents bid, execute, and settle in USDC on Arc.
        </p>
      </div>

      {/* ✅ USER-SPECIFIC STATS CARDS */}
      {isConnected && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 28 }}>
          <StatCard icon={<Bot size={16} />} label="My Agents" value={myAgentsCount} color="arc" />
          <StatCard icon={<CheckCircle size={16} />} label="My Completed Tasks" value={myCompletedTasks} color="green" />
          <StatCard icon={<DollarSign size={16} />} label="My Total Volume" value={`$${(myTotalVolume / 1_000_000).toFixed(2)}`} color="usdc" />
          <StatCard icon={<Briefcase size={16} />} label="My Jobs Done" value={myJobsCompleted} color="yellow" />
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 380px", gap: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div className="card">
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: "0.9rem", marginBottom: 4, color: "var(--arc)" }}>
                ⚡ Submit Task
              </div>
              <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                Orchestrator decomposes your task, recruits specialist agents, settles payments on-chain.
              </p>
            </div>

            {!isConnected ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "32px 20px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px dashed var(--border-bright)" }}>
                <Wallet size={32} color="var(--text-muted)" />
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontWeight: 600, marginBottom: 6, fontSize: "0.9rem" }}>Connect your wallet to submit tasks</div>
                  <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>You need a wallet on Arc Testnet with USDC to pay agents</div>
                </div>
                <ConnectButton />
              </div>
            ) : isWrongNetwork ? (
              <div style={{ padding: "20px", background: "var(--yellow-dim)", border: "1px solid rgba(245,200,66,0.3)", borderRadius: "var(--radius)", textAlign: "center", color: "var(--yellow)", fontSize: "0.85rem" }}>
                Please switch to Arc Testnet in your wallet
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <WalletInfo label="Address" value={`${address?.slice(0, 6)}...${address?.slice(-4)}`} />
                  <WalletInfo label="USDC Balance" value={`$${balanceUSDC}`} highlight />
                  <WalletInfo label="Approved" value={`$${allowanceUSDC}`} />
                </div>

                <div>
                  <label>Task Description</label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe what you need done..."
                    style={{ minHeight: 100 }}
                    disabled={isSubmitting}
                  />
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                    {EXAMPLE_TASKS.map((ex, i) => (
                      <button key={i} className="btn btn-ghost" style={{ fontSize: "0.7rem", padding: "4px 10px" }} onClick={() => setDescription(ex)} disabled={isSubmitting}>
                        Example {i + 1}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label>Budget — <span style={{ color: "var(--arc)", fontFamily: "var(--font-mono)" }}>{budgetUSDC} USDC</span></label>
                  <input type="range" min={1_000_000} max={50_000_000} step={500_000} value={budget} onChange={(e) => setBudget(Number(e.target.value))} disabled={isSubmitting} />
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>$1 USDC</span>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>$50 USDC</span>
                  </div>
                </div>

                {isSubmitting && (
                  <div style={{ padding: "12px 14px", background: "var(--arc-dim)", border: "1px solid rgba(0,212,255,0.2)", borderRadius: "var(--radius)", fontSize: "0.8rem", color: "var(--arc)", display: "flex", alignItems: "center", gap: 8 }}>
                    <Loader size={14} style={{ animation: "spin 1s linear infinite" }} />
                    {step === "checking" && "Checking your USDC allowance..."}
                    {step === "approving" && "Please confirm approval in MetaMask..."}
                    {step === "waiting-approval" && "Waiting for USDC approval on Arc..."}
                    {step === "approval-confirmed" && "USDC approved! Creating task on-chain..."}
                    {step === "creating-task" && "Task submitted! Deploying agents..."}
                  </div>
                )}

                {approveTxHash && (
                  <div style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>
                    Approval tx:{" "}
                    <a href={`https://explorer.testnet.arc.network/tx/${approveTxHash}`} target="_blank" rel="noopener noreferrer" style={{ color: "var(--arc)", textDecoration: "none", fontFamily: "var(--font-mono)" }}>
                      {String(approveTxHash).slice(0, 16)}...
                    </a>
                  </div>
                )}

                {error && (
                  <div style={{ padding: "10px 14px", background: "var(--red-dim)", border: "1px solid rgba(255,77,106,0.3)", borderRadius: "var(--radius)", color: "var(--red)", fontSize: "0.8rem" }}>
                    {error}
                  </div>
                )}

                {!isAlreadyApproved && !isSubmitting && (
                  <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "10px 12px", background: "var(--bg)", borderRadius: "var(--radius)", border: "1px solid var(--border)", fontSize: "0.75rem", color: "var(--text-secondary)" }}>
                    <ShieldCheck size={14} color="var(--arc)" style={{ flexShrink: 0, marginTop: 1 }} />
                    Clicking launch will first ask you to approve <strong style={{ color: "var(--arc)" }}>${budgetUSDC} USDC</strong> for the escrow contract, then create your task on Arc.
                  </div>
                )}

                <button
                  className="btn btn-primary"
                  onClick={handleSubmit}
                  disabled={!description.trim() || isSubmitting}
                  style={{ alignSelf: "flex-start" }}
                >
                  {isSubmitting ? (
                    <><Loader size={14} style={{ animation: "spin 1s linear infinite" }} /> {STEP_LABELS[step]}</>
                  ) : isAlreadyApproved ? (
                    <><Send size={14} /> Launch Task</>
                  ) : (
                    <><ShieldCheck size={14} /> Approve & Launch Task</>
                  )}
                </button>
              </div>
            )}
          </div>

          {/* ✅ Recent tasks: STRICTLY HIDDEN IF NOT CONNECTED */}
          <div>
            <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
              Your Recent Tasks
            </div>
            {!isConnected ? (
              <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: "0.8rem", display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
                <Wallet size={28} style={{ opacity: 0.5 }} />
                <div>Connect your wallet to view your tasks</div>
              </div>
            ) : tasks.length === 0 ? (
              <div className="card" style={{ textAlign: "center", padding: 40, color: "var(--text-muted)", fontSize: "0.8rem" }}>
                No tasks yet. Submit your first task above.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {tasks.slice(0, 8).map((task) => (
                  <TaskCard key={task.id} task={task} onClick={() => navigate(`/tasks/${task.id}`)} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Live feed */}
        <div>
          <div style={{ fontWeight: 700, fontSize: "0.85rem", color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 12 }}>
            Live Feed
          </div>
          <LiveFeed events={liveEvents} />
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: any; color: string }) {
  const colorMap: Record<string, string> = { arc: "var(--arc)", green: "var(--green)", usdc: "#5aabff", yellow: "var(--yellow)" };
  return (
    <div className="card" style={{ padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: "0.7rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>{label}</div>
          <div style={{ fontSize: "1.4rem", fontWeight: 800, color: colorMap[color], fontFamily: "var(--font-mono)" }}>{value}</div>
        </div>
        <div style={{ color: colorMap[color], opacity: 0.7 }}>{icon}</div>
      </div>
    </div>
  );
}

function WalletInfo({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div style={{ padding: "8px 10px", background: "var(--bg)", borderRadius: "var(--radius)", border: `1px solid ${highlight ? "rgba(0,212,255,0.2)" : "var(--border)"}` }}>
      <div style={{ fontSize: "0.62rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 3 }}>{label}</div>
      <div style={{ fontSize: "0.78rem", fontFamily: "var(--font-mono)", fontWeight: 700, color: highlight ? "var(--arc)" : "var(--text-secondary)" }}>{value}</div>
    </div>
  );
}