"use client";

import { usePathname } from "next/navigation";

/**
 * The dynamic segments of the current URL, read from the path itself.
 *
 * The static export (Cloudflare Pages) prerenders each dynamic route once with a placeholder value and serves
 * every real URL from that one page, so `useParams()` would report the placeholder. The pathname is always the
 * real URL, in the static export and in the Node server alike.
 */
export function usePathParams(): { contestId: string; agentId: string; address: string } {
  const parts = (usePathname() ?? "").split("/").filter(Boolean);
  // /contests/<id>[/transcripts/<address>] · /agents/<id>
  return {
    contestId: parts[0] === "contests" ? (parts[1] ?? "") : "",
    agentId: parts[0] === "agents" ? (parts[1] ?? "") : "",
    address: parts[0] === "contests" && parts[2] === "transcripts" ? (parts[3] ?? "") : "",
  };
}
