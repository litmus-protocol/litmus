"use client";

// Privy (email / Google login with an embedded Ethereum wallet). Mounted on demand by
// WalletProvider, beside the app rather than around it, so pages render without the Privy bundle.
// It renders nothing itself except Privy's own modal; state goes out through ./privy-bridge.

import { useEffect } from "react";
import { PrivyProvider, useLogin, useLogout, usePrivy, useWallets } from "@privy-io/react-auth";
import { defineChain, type Address, type Hex } from "viem";
import { HEDERA_TESTNET_CHAIN_ID } from "@defect/shared";
import { config } from "./config";
import { privyLoginFailed, setPrivyActions, updatePrivy } from "./privy-bridge";

// The relay reports HBAR with 18 decimals (weibars), like every EVM chain.
const hederaTestnet = defineChain({
  id: HEDERA_TESTNET_CHAIN_ID,
  name: "Hedera Testnet",
  nativeCurrency: { name: "HBAR", symbol: "HBAR", decimals: 18 },
  rpcUrls: { default: { http: [config.hederaRpcUrl] } },
  blockExplorers: { default: { name: "HashScan", url: "https://hashscan.io/testnet" } },
  testnet: true,
});

function Bridge() {
  const { ready, authenticated, user, getAccessToken } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const { login } = useLogin({ onError: (err) => privyLoginFailed(String(err)) });
  const { logout } = useLogout();
  const embedded = wallets.find((w) => w.walletClientType === "privy");
  const label = user?.email?.address ?? user?.google?.email ?? "Privy account";

  useEffect(() => {
    setPrivyActions({ login: () => login({ loginMethods: ["email", "google"] }), logout, getAccessToken });
    return () => setPrivyActions(null);
  }, [login, logout, getAccessToken]);

  useEffect(() => {
    updatePrivy({
      ready: ready && (!authenticated || walletsReady),
      authenticated,
      wallet: embedded
        ? {
            address: embedded.address.toLowerCase() as Address,
            label,
            async sign(hash: Hex) {
              const provider = await embedded.getEthereumProvider();
              return (await provider.request({ method: "secp256k1_sign", params: [hash] })) as Hex;
            },
          }
        : null,
    });
  }, [ready, authenticated, walletsReady, embedded, label]);

  return null;
}

export default function PrivyRoot() {
  return (
    <PrivyProvider
      appId={config.privyAppId}
      config={{
        loginMethods: ["email", "google"],
        appearance: { theme: "light", walletChainType: "ethereum-only" },
        embeddedWallets: {
          ethereum: { createOnLogin: "all-users" },
          // Signing happens per message (x402), like the dev key; no confirmation pop-up each time.
          showWalletUIs: false,
        },
        supportedChains: [hederaTestnet],
        defaultChain: hederaTestnet,
      }}
    >
      <Bridge />
    </PrivyProvider>
  );
}
