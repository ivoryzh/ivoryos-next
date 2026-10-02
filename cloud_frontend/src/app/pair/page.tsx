"use client";
import Link from 'next/link';
import { ArrowLeft, Link2 } from 'lucide-react';
import PairDevice from '@/components/PairDevice';

/**
 * The pairing form as a page of its own: where the link a device shows with its code leads. From
 * Cloud itself it opens as a pop-up over Devices instead (PairDevice), so this page always offers
 * the way back there, in the content rather than the header (a top bar hides title headers).
 */
export default function PairPage() {
  return (
    <div className="flex-1 flex flex-col h-full w-full overflow-y-auto">
      <header data-ivoryos-page-header="title" className="h-16 shrink-0 border-b flex items-center px-8 z-10 glass-header" style={{ borderColor: 'var(--panel-border)' }}>
        <div className="flex items-center space-x-3 text-gray-500 dark:text-gray-300">
          <Link2 className="w-5 h-5" />
          <h1 className="text-xl font-bold tracking-wider" style={{ color: 'var(--text-primary)' }}>Pair a device</h1>
        </div>
      </header>

      <div className="pt-6 px-8 pb-8 max-w-2xl mx-auto w-full space-y-4">
        <Link href="/devices" className="inline-flex items-center gap-1.5 text-sm hover:underline" style={{ color: 'var(--text-secondary)' }}>
          <ArrowLeft className="w-4 h-4" /> Devices
        </Link>
        <PairDevice />
      </div>
    </div>
  );
}
