import type { Metadata } from "next";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { SiteFooter } from "@/components/layout/SiteFooter";
import { SmoothScroll } from "@/components/ui/motion";
import { ChromeFrame } from "@/components/layout/ChromeFrame";
import { Toaster } from "@/components/layout/Toaster";
import { WalletDrawer } from "@/components/layout/WalletDrawer";
import { Providers } from "./providers";
import "./globals.css";

// Satoshi carries the whole type system (real weights and italics); Doto is
// the dot-matrix accent, built from the same grid as the halftone artwork.
// Both self-hosted, so there is no Google Fonts request at runtime.
const satoshi = localFont({
  src: [
    { path: "./fonts/Satoshi-400.woff2", weight: "400", style: "normal" },
    { path: "./fonts/Satoshi-400-italic.woff2", weight: "400", style: "italic" },
    { path: "./fonts/Satoshi-500.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Satoshi-700.woff2", weight: "700", style: "normal" },
    { path: "./fonts/Satoshi-700-italic.woff2", weight: "700", style: "italic" },
    { path: "./fonts/Satoshi-900.woff2", weight: "900", style: "normal" },
    { path: "./fonts/Satoshi-900-italic.woff2", weight: "900", style: "italic" },
  ],
  variable: "--font-satoshi",
  display: "swap",
});

const doto = localFont({
  src: "./fonts/Doto-Variable.ttf",
  variable: "--font-accent",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Litmus · Trustless validation of agents.",
  description: "Non-custodial model validation. Labs stake capital behind what their models will never do, anyone can try to break them, and smart contracts settle the verdict onchain.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${satoshi.variable} ${doto.variable}`} suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-text">
        <Providers>
          <SmoothScroll>
            <ChromeFrame>
              <AppHeader />
            </ChromeFrame>
            {/* At least one screen tall, so the footer sits below the fold on short pages (loading, not found). */}
            <div className="min-h-[calc(100svh-var(--chrome))]">{children}</div>
            <SiteFooter />
            <WalletDrawer />
            <Toaster />
          </SmoothScroll>
        </Providers>
      </body>
    </html>
  );
}
