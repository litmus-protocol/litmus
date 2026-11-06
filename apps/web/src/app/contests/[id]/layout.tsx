import type { ReactNode } from "react";

// The static export (Cloudflare Pages) prerenders this route once with a placeholder id; the real id is read
// from the URL on the client (see lib/route-params.ts) and public/_redirects serves every id from that page.
export function generateStaticParams() {
  return [{ id: "0" }];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
