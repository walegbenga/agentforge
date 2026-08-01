import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useReadContract } from "wagmi";
import { useState } from "react";
import { arcTestnet, CONTRACTS, USDC_ABI } from "../../config/wagmi";
import { Wallet, AlertTriangle } from "lucide-react";

async function addArcTestnetToMetaMask() {
  const ethereum = (window as any).ethereum;
  if (!ethereum) {
    alert("MetaMask not found. Please install MetaMask.");
    return false;
  }

  try {
    // First try switching
    await ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x4CEF52" }], // 5042002 in hex — was "0x4CE152" (5038418), a typo that matched neither the old comment's claimed 2911 nor the real chain ID used everywhere else in this app
    });
    return true;
  } catch (switchError: any) {
    // Chain not added yet — add it
    if (switchError.code === 4902 || switchError.code === -32603) {
      try {
        await ethereum.request({
          method: "wallet_addEthereumChain",
          params: [
            {
              chainId: "0x4CEF52",
              chainName: "Arc Testnet",
              nativeCurrency: {
                name: "USDC",
                symbol: "USDC",
                decimals: 6,
              },
              rpcUrls: [arcTestnet.rpcUrls.default.http[0]],
              blockExplorerUrls: ["https://explorer.testnet.arc.network"],
            },
          ],
        });
        return true;
      } catch (addError: any) {
        console.error("Failed to add Arc Testnet:", addError);
        return false;
      }
    }
    console.error("Failed to switch network:", switchError);
    return false;
  }
}

export default function WalletButton() {
  const { address, isConnected, chainId } = useAccount();
  const [switching, setSwitching] = useState(false);
  const isWrongNetwork = isConnected && chainId !== arcTestnet.id;

  const { data: balance } = useReadContract({
  address: CONTRACTS.USDC,
  abi: USDC_ABI,
  functionName: "balanceOf",
  args: address ? [address] : undefined,
  query: { 
    enabled: !!address && chainId === arcTestnet.id,
    refetchInterval: 30000,
    staleTime: 20000,
  },
});

  const balanceUSDC = balance
    ? (Number(balance as bigint) / 1_000_000).toFixed(2)
    : "0.00";

  const handleSwitch = async () => {
    setSwitching(true);
    await addArcTestnetToMetaMask();
    setSwitching(false);
  };

  if (isWrongNetwork) {
    return (
      <button
        onClick={handleSwitch}
        disabled={switching}
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
          cursor: switching ? "not-allowed" : "pointer",
          opacity: switching ? 0.7 : 1,
        }}
      >
        <AlertTriangle size={14} />
        {switching ? "Adding network..." : "Switch to Arc Testnet"}
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
          <span style={{
            fontSize: "0.7rem",
            color: "#5aabff",
            fontFamily: "var(--font-mono)",
            fontWeight: 700,
          }}>
            ${balanceUSDC} USDC
          </span>
        </div>

        {/* Address */}
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
