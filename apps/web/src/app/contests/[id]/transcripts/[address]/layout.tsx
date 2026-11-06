import type { ReactNode } from "react";

// See contests/[id]/layout.tsx: one placeholder page for the static export.
export function generateStaticParams() {
  return [{ address: "0" }];
}

export default function Layout({ children }: { children: ReactNode }) {
  return children;
}
