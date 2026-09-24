import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Inter } from 'next/font/google';
import "../globals.css";
import "../xyflow.css";
import Script from "next/script";
import Sidebar from "@/components/Sidebar";

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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`dark ${geistSans.variable} ${geistMono.variable}`}>
      <body className={inter.className}>
        {/* Applies a saved light theme before first paint. `next/script` rather than a raw
            <script>: React renders a raw one on the client as inert markup and warns about it
            ("Encountered a script tag while rendering React component"), whereas
            beforeInteractive is injected into the server HTML by Next itself. */}
        <Script id="theme-init" strategy="beforeInteractive">{`
          try {
            if (localStorage.theme === 'light') {
              document.documentElement.classList.remove('dark');
              document.documentElement.classList.add('light');
            }
          } catch (_) {}
        `}</Script>
        <div className="flex h-screen w-full overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-hidden relative">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
