// Bridge between the Privy React tree (PrivyRoot, loaded on demand) and the rest of the app.
// Holds the embedded wallet's raw-hash signer so the live client can sign without React.
// No Privy imports here, so importing this module costs nothing.

import type { Address, Hex } from "viem";

export interface PrivyEmbeddedWallet {
  address: Address; // lowercase
  label: string;
  /** EIP-1193 `secp256k1_sign`: unprefixed signature over a 32-byte hash (65 bytes, hex). */
  sign(hash: Hex): Promise<Hex>;
}

interface PrivyBridgeState {
  /** Privy SDK initialised (session restored or known absent). */
  ready: boolean;
  authenticated: boolean;
  wallet: PrivyEmbeddedWallet | null;
}

interface PrivyActions {
  login(): void;
  logout(): Promise<void>;
}

let state: PrivyBridgeState = { ready: false, authenticated: false, wallet: null };
let actions: PrivyActions | null = null;
const listeners = new Set<() => void>();
let pending: { resolve(w: PrivyEmbeddedWallet): void; reject(e: Error): void } | null = null;

function emit() {
  for (const l of listeners) l();
}

/** Called by PrivyRoot whenever Privy's auth or wallet state changes. */
export function updatePrivy(next: PrivyBridgeState): void {
  state = next;
  if (pending && state.wallet) {
    pending.resolve(state.wallet);
    pending = null;
  }
  emit();
}

export function setPrivyActions(a: PrivyActions | null): void {
  actions = a;
  emit();
}

/** Called by PrivyRoot when the login modal closes without a login. */
export function privyLoginFailed(reason: string): void {
  if (!pending) return;
  pending.reject(new Error(reason === "exited_auth_flow" ? "Login cancelled." : `Privy login failed (${reason}).`));
  pending = null;
}

export function privyState(): PrivyBridgeState {
  return state;
}

export function onPrivyChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Resolves once PrivyRoot is mounted and Privy has initialised (or rejects after `timeoutMs`). */
export function whenPrivyReady(timeoutMs = 15_000): Promise<PrivyBridgeState> {
  if (state.ready && actions) return Promise.resolve(state);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error("Privy didn't start. Check NEXT_PUBLIC_PRIVY_APP_ID and that this site's origin is allowed in the Privy dashboard."));
    }, timeoutMs);
    const off = onPrivyChange(() => {
      if (state.ready && actions) {
        clearTimeout(timer);
        off();
        resolve(state);
      }
    });
  });
}

/** Opens the Privy login (email / Google) and resolves with the embedded wallet once it exists. */
export async function loginWithPrivy(): Promise<PrivyEmbeddedWallet> {
  const s = await whenPrivyReady();
  if (s.wallet) return s.wallet;
  pending?.reject(new Error("Login restarted."));
  const p = new Promise<PrivyEmbeddedWallet>((resolve, reject) => {
    pending = { resolve, reject };
  });
  // Already logged in but the wallet is still being created: just wait for it.
  if (!s.authenticated) actions!.login();
  return p;
}

export async function logoutPrivy(): Promise<void> {
  if (actions && state.authenticated) await actions.logout();
}

/** The raw-hash signer for `address`, or an error if that Privy wallet isn't logged in here. */
export function privySigner(address: Address): (hash: Hex) => Promise<Hex> {
  return (hash) => {
    const w = state.wallet;
    if (!w || w.address !== address.toLowerCase()) {
      return Promise.reject(new Error("Your Privy session ended. Log in again from the wallet menu."));
    }
    return w.sign(hash);
  };
}
