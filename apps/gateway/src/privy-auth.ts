import { createPublicKey, verify, type KeyObject } from "node:crypto";

// Privy access tokens (the web app's getAccessToken()): ES256 JWTs with iss "privy.io", aud = the
// Privy app id and sub = the Privy user id. Checked locally against the app's verification key
// (Privy dashboard → App settings → Verification key), so no Privy API call and no app secret.

export interface PrivyVerifier {
  /** The Privy user id (`did:privy:…`) of a valid token; throws on anything else. */
  verify(token: string, nowSec: number): string;
}

export function privyVerifier(appId: string, verificationKey: string): PrivyVerifier {
  // .env files usually carry the PEM on one line with literal "\n". Privy rotates its signing keys, so
  // several PEMs may be listed (concatenated or comma-separated): a token is valid if any key verifies it.
  const pems = verificationKey.replace(/\\n/g, "\n").match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g);
  if (!pems) throw new Error("PRIVY_VERIFICATION_KEY has no PEM public key");
  const keys = pems.map((pem) => createPublicKey(pem));
  return {
    verify: (token, nowSec) => {
      let last: unknown;
      for (const key of keys) {
        try {
          return verifyPrivyToken(token, { appId, key, nowSec });
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },
  };
}

function json(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("malformed token");
  return value as Record<string, unknown>;
}

export function verifyPrivyToken(token: string, opts: { appId: string; key: KeyObject; nowSec: number }): string {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts as [string, string, string];
  if (json(h).alg !== "ES256") throw new Error("unexpected token algorithm");
  const ok = verify("sha256", Buffer.from(`${h}.${p}`), { key: opts.key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
  if (!ok) throw new Error("bad token signature");
  const claims = json(p);
  if (claims.iss !== "privy.io") throw new Error("token not issued by Privy");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.appId)) throw new Error("token is for another Privy app");
  if (typeof claims.exp !== "number" || claims.exp <= opts.nowSec) throw new Error("token expired");
  if (typeof claims.nbf === "number" && claims.nbf > opts.nowSec + 60) throw new Error("token not valid yet");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("token has no user");
  return claims.sub;
}
