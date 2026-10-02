"use client";

import { useEffect, useState } from 'react';

/**
 * A device is identified by its lasting id (`my-deck-7k4m2q`: its MQTT client id and, on AWS, its
 * Thing name) and shown by the name a person gave it, which is unique within a workspace
 * (deviceNaming.ts). Pages that hold only ids -- a run's tasks, an attention item -- read names
 * through this. One fetch shared by every component on the page, refreshed when one mounts after
 * a while; an id with no known name (a removed device, say) is shown as itself.
 */
const STALE_MS = 30_000;
let names = new Map<string, string>();
let loadedAt = 0;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function refresh() {
  if (inFlight || Date.now() - loadedAt < STALE_MS) return;
  inFlight = fetch('/api/devices', { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : []))
    .then((rows: any[]) => {
      names = new Map((Array.isArray(rows) ? rows : []).map((d) => [String(d.id), String(d.name || d.id)]));
      loadedAt = Date.now();
      listeners.forEach((l) => l());
    })
    .catch(() => {})
    .finally(() => { inFlight = null; });
}

/** `name(id)`: the device's name, or the id itself until (or unless) a name is known. */
export function useDeviceName(): (id: string | null | undefined) => string {
  const [, rerender] = useState(0);
  useEffect(() => {
    const l = () => rerender((n) => n + 1);
    listeners.add(l);
    refresh();
    return () => { listeners.delete(l); };
  }, []);
  return (id) => (id ? names.get(String(id)) || String(id) : '');
}
