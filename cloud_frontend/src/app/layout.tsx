import type { Metadata } from "next";
import { cookies } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import { Inter } from 'next/font/google';
import "../globals.css";
import "../xyflow.css";
import AppShell from "@/components/AppShell";
import { ThemeSync } from "@ivoryos/shared-ui";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "IvoryOS Cloud",
  description: "Distributed edge workflow orchestrator.",
};

/**
 * The theme is set on <html> by the server, from the `theme` cookie that ThemeSync keeps equal to
 * the one IvoryOS theme (shared-ui theme.tsx; inside the desktop app, the app sets it too).
 * It used to be a pre-paint <script>, which React 19 reports as an error ("Encountered a script
 * tag while rendering React component") in every form tried -- raw, and via next/script both
 * inline and as a `src`. A class chosen on the server needs no script and cannot flash.
 */
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const theme = (await cookies()).get('theme')?.value === 'light' ? 'light' : 'dark';
  return (
    <html lang="en" suppressHydrationWarning className={`${theme} ${geistSans.variable} ${geistMono.variable}`}>
      <body className={inter.className}>
        <ThemeSync cookie="theme" />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
