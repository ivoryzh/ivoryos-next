"use client";
import React from 'react';
import { AlertTriangle, Cloud, Copy, ExternalLink } from 'lucide-react';
import type { CloudLink, DesktopApi, Profile } from '@/desktop';
import { Button, cardClass } from './ui';

const STATE: Record<string, { label: string; dot: string }> = {
  connected: { label: 'Connected', dot: 'bg-green-500' },
  connecting: { label: 'Connecting', dot: 'bg-amber-400 animate-pulse' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-amber-400 animate-pulse' },
  conflict: { label: 'Identity in use elsewhere', dot: 'bg-red-500' },
  error: { label: 'Could not connect', dot: 'bg-red-500' },
  disconnected: { label: 'Not connected', dot: 'bg-gray-300 dark:bg-gray-600' },
};

/**
 * Other running profiles paired under the same Cloud identity as this one. Two clients with one
 * MQTT client id evict each other; this catches it among the launcher's own profiles even when
 * the edge is too old to notice (the edge itself reports "conflict" when it can).
 */
export function sharedIdentity(profile: Profile, profiles: Profile[], links: Record<string, CloudLink>): Profile[] {
  const mine = links[profile.id]?.client_id;
  if (!mine) return [];
  return profiles.filter(p => p.id !== profile.id && links[p.id]?.paired && links[p.id]?.client_id === mine);
}

/** The profile's Cloud link, on its Configuration / Settings tab: state, identity, and where the pairing lives. */
export default function CloudConnection({ api, profile, link, sharedWith }: {
  api: DesktopApi;
  profile: Profile;
  link?: CloudLink;
  sharedWith: Profile[];
}) {
  const running = profile.status.state === 'running';
  const state = !link ? null : !link.paired ? 'disconnected' : sharedWith.length ? 'conflict' : (link.connection_state || 'disconnected');
  const look = state ? STATE[state] || STATE.disconnected : null;

  return (
    <section className={`${cardClass} p-4 space-y-3`}>
      <div className="flex items-center gap-2">
        <Cloud className="w-4 h-4 text-indigo-500" />
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 flex-1">Cloud connection</h3>
        {running && (
          <Button small onClick={() => api.open(profile.id, '/cloud/')} title="This edge's Cloud Connect page: pair with a code, or unpair">
            {link?.paired ? 'Manage' : 'Pair with Cloud'} <ExternalLink className="w-3 h-3" />
          </Button>
        )}
      </div>

      {!running ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Start the profile to see its Cloud connection. The pairing is kept by the edge, so it is read from the running process.</p>
      ) : !link ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">Asking the edge…</p>
      ) : (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span className={`w-2 h-2 rounded-full shrink-0 ${look!.dot}`} />
            <span className="font-medium">{look!.label}</span>
            {link.paired && link.client_id && <span className="text-gray-500 dark:text-gray-400">as <span className="font-mono">{link.client_id}</span></span>}
            {link.broker && <span className="text-gray-400 font-mono text-xs truncate">· {link.broker}</span>}
          </div>

          {sharedWith.length > 0 && (
            <Problem>
              <b>{sharedWith.map(p => p.name).join(', ')}</b> {sharedWith.length === 1 ? 'is' : 'are'} paired as the same device (<span className="font-mono">{link.client_id}</span>) and running now.
              The two take turns kicking each other off Cloud. Stop one, or pair one as its own device.
            </Problem>
          )}
          {!sharedWith.length && link.connection_error && <Problem>{link.connection_error}</Problem>}

          {link.pairing_file && (
            <div className="text-xs text-gray-500 dark:text-gray-400 space-y-1">
              <div className="flex items-center gap-2">
                <span className="whitespace-nowrap">Pairing kept in</span>
                <span className="font-mono text-gray-700 dark:text-gray-300 truncate" title={link.pairing_file}>{link.pairing_file}</span>
                <button type="button" title="Copy the path" onClick={() => api.copy(link.pairing_file!)} className="text-gray-400 hover:text-gray-600"><Copy className="w-3 h-3" /></button>
              </div>
              {profile.kind === 'script' && link.paired && (
                <div>Every copy of this edge started with that file is the same Cloud device, including one started from a terminal. Run one at a time.</div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Problem({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm rounded-lg p-2.5 bg-red-50 text-red-800 dark:bg-red-900/15 dark:text-red-300">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}
