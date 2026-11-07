"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getWallets,
  isWalletWithRequiredFeatureSet,
  type SuiSignPersonalMessageFeature,
  type Wallet,
  type WalletAccount,
} from "@mysten/wallet-standard";

type SignerWallet = Wallet & { features: SuiSignPersonalMessageFeature & Wallet["features"] };
const LAST_WALLET = "calibro-last-wallet";

/** Minimal Sui Wallet Standard connection: discover, connect, sign personal messages. */
export function useSuiWallet() {
  const [wallets, setWallets] = useState<SignerWallet[]>([]);
  const [wallet, setWallet] = useState<SignerWallet | null>(null);
  const [account, setAccount] = useState<WalletAccount | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = getWallets();
    const update = () =>
      setWallets(
        api.get().filter((w): w is SignerWallet => isWalletWithRequiredFeatureSet<SuiSignPersonalMessageFeature>(w, ["sui:signPersonalMessage"]))
      );
    update();
    const offs = [api.on("register", update), api.on("unregister", update)];
    return () => offs.forEach((off) => off());
  }, []);

  const connect = useCallback(async (w: SignerWallet, silent = false) => {
    setError(null);
    try {
      const res = await (w.features["standard:connect"] as { connect: (i?: { silent?: boolean }) => Promise<{ accounts: readonly WalletAccount[] }> }).connect(
        silent ? { silent: true } : undefined
      );
      const acct = res.accounts.find((a) => a.chains.includes("sui:mainnet")) ?? res.accounts[0];
      if (!acct) {
        if (!silent) setError(`${w.name} returned no account.`);
        return;
      }
      setWallet(w);
      setAccount(acct);
      window.localStorage.setItem(LAST_WALLET, w.name);
    } catch (e) {
      if (!silent) setError((e as Error).message);
    }
  }, []);

  // Reconnect silently to the last wallet used in this browser.
  useEffect(() => {
    if (account || wallets.length === 0) return;
    const last = window.localStorage.getItem(LAST_WALLET);
    const w = wallets.find((x) => x.name === last);
    if (w) void connect(w, true);
  }, [wallets, account, connect]);

  const disconnect = useCallback(async () => {
    const feature = wallet?.features["standard:disconnect"] as { disconnect?: () => Promise<void> } | undefined;
    await feature?.disconnect?.().catch(() => undefined);
    window.localStorage.removeItem(LAST_WALLET);
    setWallet(null);
    setAccount(null);
  }, [wallet]);

  const signMessage = useCallback(
    async (text: string) => {
      if (!wallet || !account) throw new Error("Connect a wallet first.");
      const out = await wallet.features["sui:signPersonalMessage"].signPersonalMessage({
        message: new TextEncoder().encode(text),
        account,
        chain: "sui:mainnet",
      });
      return out.signature;
    },
    [wallet, account]
  );

  return { wallets, wallet, account, address: account?.address ?? null, error, connect, disconnect, signMessage };
}
