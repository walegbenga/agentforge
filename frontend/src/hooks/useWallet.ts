import { useState } from "react";
import {
  useAccount,
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from "wagmi";
import { arcTestnet, CONTRACTS, USDC_ABI } from "../config/wagmi";

// Load escrow address from env
const ESCROW_ADDRESS = (
  import.meta.env.VITE_ESCROW_ADDRESS || ""
) as `0x${string}`;

export type ApprovalState =
  | "idle"
  | "checking"
  | "approving"
  | "waiting-approval"
  | "approved"
  | "error";

export function useUSDCApproval(amount: number) {
  const { address } = useAccount();
  const [state, setState] = useState<ApprovalState>("idle");
  const [error, setError] = useState<string>("");

  // Check current allowance
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: USDC_ABI,
    functionName: "allowance",
    args: address ? [address, ESCROW_ADDRESS] : undefined,
    query: { enabled: !!address && !!ESCROW_ADDRESS },
  });

  // Check USDC balance
  const { data: balance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { writeContract, data: approveTxHash } = useWriteContract();

  const { isSuccess: approvalConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    query: { enabled: !!approveTxHash },
  });

  const isAlreadyApproved =
    allowance !== undefined && BigInt(allowance) >= BigInt(amount);

  const hasEnoughBalance =
    balance !== undefined && BigInt(balance) >= BigInt(amount);

  const approve = async () => {
    if (!address) {
      setError("No wallet connected");
      return false;
    }

    if (!hasEnoughBalance) {
      setError(
        `Insufficient USDC balance. Have ${Number(balance ?? 0) / 1_000_000} USDC, need ${amount / 1_000_000} USDC`
      );
      setState("error");
      return false;
    }

    if (isAlreadyApproved) {
      setState("approved");
      return true;
    }

    try {
      setState("approving");
      writeContract({
        address: CONTRACTS.USDC,
        abi: USDC_ABI,
        functionName: "approve",
        args: [ESCROW_ADDRESS, BigInt(amount)],
        chainId: arcTestnet.id,
      });
      setState("waiting-approval");
      return true;
    } catch (err: any) {
      setError(err.message || "Approval failed");
      setState("error");
      return false;
    }
  };

  return {
    approve,
    state: approvalConfirmed ? "approved" : state,
    error,
    isAlreadyApproved,
    hasEnoughBalance,
    allowance: Number(allowance ?? 0) / 1_000_000,
    balance: Number(balance ?? 0) / 1_000_000,
    approveTxHash,
  };
}
