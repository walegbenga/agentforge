import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract, useSwitchChain } from "wagmi";
import { useEffect } from "react";
import { arcTestnet, CONTRACTS, USDC_ABI } from "../../config/wagmi";
import { Wallet, AlertTriangle } from "lucide-react";

export default function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const { switchChain } = useSwitchChain();
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;

  // Auto-switch to Arc Testnet
  useEffect(() => {
    if (isWrongNetwork) {
      switchChain({ chainId: arcTestnet.id });
    }
  }, [isWrongNetwork, switchChain]);

  // Get USDC balance
  const { data: balance } = useReadContract({
    address: CONTRACTS.USDC,
    abi: USDC_ABI,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const balanceUSDC = balance ? (Number(balance) / 1_000_000).toFixed(2) : "0.00";

  if (isWrongNetwork) {
    return (
      <button
        onClick={() => switchChain({ chainId: arcTestnet.id })}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "8px 16px",
          background: "var(--red-dim)",
          border: "1px solid rgba(255,77,106,0.4)",
          borderRadius: "var(--radius)",
          color: "var(--red)",
          fontFamily: "var(--font-display)",
          fontWeight: 600,
          fontSize: "0.8rem",
          cursor: "pointer",
        }}
      >
        <AlertTriangle size={14} />
        Switch to Arc Testnet
      </button>
    );
  }

  if (isConnected && address) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* USDC Balance */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "6px 12px",
          background: "var(--usdc-dim)",
          border: "1px solid rgba(39,117,202,0.2)",
          borderRadius: "var(--radius)",
        }}>
          <span style={{ fontSize: "0.7rem", color: "#5aabff", fontFamily: "var(--font-mono)", fontWeight: 700 }}>
            ${balanceUSDC} USDC
          </span>
        </div>

        {/* Address + Disconnect */}
        <ConnectButton.Custom>
          {({ openAccountModal }) => (
            <button
              onClick={openAccountModal}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "6px 12px",
                background: "var(--arc-dim)",
                border: "1px solid rgba(0,212,255,0.2)",
                borderRadius: "var(--radius)",
                color: "var(--arc)",
                fontFamily: "var(--font-mono)",
                fontSize: "0.75rem",
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              <div style={{
                width: 8, height: 8,
                borderRadius: "50%",
                background: "var(--green)",
                boxShadow: "0 0 6px var(--green)",
              }} />
              {address.slice(0, 6)}...{address.slice(-4)}
            </button>
          )}
        </ConnectButton.Custom>
      </div>
    );
  }

  return (
    <ConnectButton.Custom>
      {({ openConnectModal }) => (
        <button
          onClick={openConnectModal}
          className="btn btn-primary"
          style={{ fontSize: "0.8rem", padding: "8px 16px" }}
        >
          <Wallet size={14} />
          Connect Wallet
        </button>
      )}
    </ConnectButton.Custom>
  );
}
