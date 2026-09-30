import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Inter } from 'next/font/google';
import GlobalQueueBar from '@/components/GlobalQueueBar';
import PluginPanelHost from '@/components/PluginPanel';
import { ThemeSync } from '@ivoryos/shared-ui';
import "./globals.css";

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
  title: "IvoryOS",
  description: "Next-generation Edge OS for scientific instruments",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className={inter.className}>
        {/* One theme for every page, the same one the desktop app and Cloud show. */}
        <ThemeSync />
        {/* Around the pages, not inside one: a plugin panel stays mounted while you navigate. */}
        <PluginPanelHost>{children}</PluginPanelHost>
        <GlobalQueueBar />
      </body>
    </html>
  );
}
