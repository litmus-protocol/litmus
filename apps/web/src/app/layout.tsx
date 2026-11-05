import type { Metadata } from "next";
import { DM_Sans, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { AppHeader } from "@/components/layout/AppHeader";
import { TestnetBanner } from "@/components/layout/TestnetBanner";
import { Toaster } from "@/components/layout/Toaster";
import { WalletDrawer } from "@/components/layout/WalletDrawer";
import { Providers } from "./providers";
import "./globals.css";

const dmSans = DM_Sans({ subsets: ["latin"], variable: "--font-dm-sans", display: "swap" });
const jbMono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jb-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Defect · Break the AI. Take the pool.",
  description: "AI teams stake money on their agents' safety rules. Make the agent break one and the contract pays you instantly.",
};

// Applies the saved theme before paint to avoid a flash.
const themeScript = `try{var t=localStorage.getItem("defect.theme");if(t==="light")document.documentElement.dataset.theme="light"}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${dmSans.variable} ${jbMono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-screen bg-bg text-text">
        <Providers>
          <TestnetBanner />
          <AppHeader />
          {children}
          <WalletDrawer />
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
