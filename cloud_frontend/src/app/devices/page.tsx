"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Server, RefreshCw, AlertTriangle, CalendarClock, Table2, ImagePlus, X, Layers, Plus, Pencil, Trash2 } from 'lucide-react';
import { confirmDialog, notify, promptDialog } from '@ivoryos/shared-ui';
import DeviceAvatar, { toThumbnail } from '@/components/DeviceAvatar';

/**
 * Every paired device at a glance: up or down, busy or free, what it is running for Cloud and how
 * far along, what Cloud is holding for it, and what it last sent back. Built entirely from what
 * devices already report (/api/device-overview); nothing here asks a device anything.
 */

type Overview = {
  id: string;
  name: string;
  status: string;
  busy: boolean;
  lastSeen: string | null;
  deckVersion: number | null;
  computer: string | null;
  os: string | null;
  imageVersion: string | null;
  instruments: number;
  optimizers: number;
  workflows: number;
  brokenWorkflows: number;
  current: { runId: string; nodeId: string; runName: string; status: string; progress: any } | null;
  waiting: number;
  lastResult: { runId: string; nodeId: string; name: string; status: string; at: string } | null;
  nextSchedule: { name: string; at: string } | null;
};

function ago(iso: string | null) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (Number.isNaN(s)) return '—';
  if (s < 60) return `${Math.max(s, 0)} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
}

const edgeTime = (v?: string | null) => {
  if (!v) return NaN;
  return Date.parse(/([zZ]|[+-]\d{2}:?\d{2})$/.test(v) ? v : `${v}Z`);
};

/**
 * The device's picture, and where to change it: click to pick an image (scaled to a thumbnail in
 * the browser before upload), or the small cross to remove it.
 */
function DevicePicture({ device, onChanged }: { device: Overview; onChanged: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const url = `/api/devices/${encodeURIComponent(device.id)}/image`;

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const image = await toThumbnail(file);
      const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload failed.');
      onChanged();
    } catch (e: any) {
      notify(e.message || 'Could not set the picture.', { tone: 'error' });
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await fetch(url, { method: 'DELETE' });
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group relative shrink-0">
      <button
        onClick={() => input.current?.click()} disabled={busy}
        title={device.imageVersion ? 'Change picture' : 'Add a picture of this device'}
        className="relative block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-60"
      >
        {device.imageVersion
          ? <DeviceAvatar id={device.id} version={device.imageVersion} size={52} className="rounded-lg" />
          : (
            <span className="flex h-[52px] w-[52px] items-center justify-center rounded-lg border border-dashed border-gray-300 text-gray-400 hover:border-indigo-400 hover:text-indigo-500 dark:border-white/15">
              <ImagePlus className="h-5 w-5" />
            </span>
          )}
      </button>
      {device.imageVersion && (
        <button
          onClick={remove} disabled={busy} title="Remove picture"
          className="absolute -right-1.5 -top-1.5 hidden rounded-full border border-gray-200 bg-white p-0.5 text-gray-500 shadow group-hover:block hover:text-red-500 dark:border-white/10 dark:bg-gray-900"
        >
          <X className="h-3 w-3" />
        </button>
      )}
      <input ref={input} type="file" accept="image/*" className="hidden" onChange={e => upload(e.target.files?.[0])} />
    </div>
  );
}

export default function DevicesPage() {
  const [devices, setDevices] = useState<Overview[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [platforms, setPlatforms] = useState<{ id: string; name: string; device_ids: string[] }[]>([]);
  // Devices paired before sign-in, which a lab's own Cloud lets this workspace take (api/devices/claim).
  const [claim, setClaim] = useState<string[]>([]);
  const loadPlatforms = useCallback(async () => {
    const res = await fetch('/api/platforms');
    if (res.ok) setPlatforms(await res.json());
  }, []);
  useEffect(() => {
    loadPlatforms();
    fetch('/api/devices/claim').then((r) => (r.ok ? r.json() : null)).then((b) => { if (b && b.allowed) setClaim(b.devices || []); }).catch(() => {});
  }, [loadPlatforms]);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/device-overview');
      const data = await res.json();
      setDevices(Array.isArray(data) ? data : []);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [load]);

  // Platforms: named groups of this workspace's edges (api/platforms). Each device appears once,
  // under its platform or under "Not in a platform".
  const groups: { id: string | null; name: string; devices: Overview[] }[] = [
    ...platforms.map((p) => ({ id: p.id, name: p.name, devices: devices.filter((d) => p.device_ids.includes(d.id)) })),
    { id: null, name: 'Not in a platform', devices: devices.filter((d) => !platforms.some((p) => p.device_ids.includes(d.id))) },
  ].filter((g) => g.id || g.devices.length || platforms.length === 0);
  const platformOf = (id: string) => platforms.find((p) => p.device_ids.includes(id))?.id || '';

  const savePlatform = async (method: string, body: object | null, query = '') => {
    const res = await fetch(`/api/platforms${query}`, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) { await notify((await res.json().catch(() => ({}))).error || 'Could not save the platform.', { tone: 'error' }); return; }
    loadPlatforms();
  };
  const newPlatform = async () => {
    const name = await promptDialog('Name the platform, e.g. "Flow rig". It groups edges that work together.', { title: 'New platform' });
    if (name && name.trim()) savePlatform('POST', { name: name.trim() });
  };
  const renamePlatform = async (id: string, current: string) => {
    const name = await promptDialog('Rename the platform.', { title: 'Rename platform', defaultValue: current });
    if (name && name.trim()) savePlatform('PATCH', { id, name: name.trim() });
  };
  const deletePlatform = async (id: string, name: string) => {
    if (await confirmDialog(`Delete "${name}"? Its devices stay; they are only ungrouped.`, { title: 'Delete platform?', confirmLabel: 'Delete', tone: 'danger' })) {
      savePlatform('DELETE', null, `?id=${encodeURIComponent(id)}`);
    }
  };
  const moveTo = async (deviceId: string, platformId: string) => {
    if (platformId) {
      const target = platforms.find((p) => p.id === platformId)!;
      await savePlatform('PATCH', { id: platformId, device_ids: [...target.device_ids.filter((d) => d !== deviceId), deviceId] });
    } else {
      const from = platforms.find((p) => p.device_ids.includes(deviceId));
      if (from) await savePlatform('PATCH', { id: from.id, device_ids: from.device_ids.filter((d) => d !== deviceId) });
    }
  };
  const claimAll = async () => {
    const res = await fetch('/api/devices/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: claim }) });
    if (res.ok) { setClaim([]); load(); } else { await notify((await res.json().catch(() => ({}))).error || 'Could not add the devices.', { tone: 'error' }); }
  };

  const removeDevice = async (d: Overview) => {
    const ok = await confirmDialog(
      `Remove "${d.name}" from Cloud? It stops syncing and can no longer run Cloud tasks; if it is running, it forgets this Cloud. `
      + 'Its past runs and results stay. Pairing it again brings it back.',
      { title: 'Remove this device?', confirmLabel: 'Remove', tone: 'danger' },
    );
    if (!ok) return;
    const res = await fetch(`/api/devices/${encodeURIComponent(d.id)}`, { method: 'DELETE' });
    if (!res.ok) await notify((await res.json().catch(() => ({}))).error || 'Could not remove the device.', { tone: 'error' });
    load();
  };

  const renderDevice = (d: Overview) => {
            const online = d.status === 'online';
            const paused = d.status === 'paused';
            const pr = d.current?.progress;
            const pct = pr?.total ? Math.round((pr.done / pr.total) * 100) : 0;
            return (
              <div key={d.id} className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--panel-border)', background: 'var(--panel-bg, transparent)' }}>
                <div className="flex items-start justify-between gap-3">
                  <DevicePicture device={d} onChanged={load} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${paused ? 'bg-indigo-400' : !online ? 'bg-gray-400' : d.busy ? 'bg-amber-400' : 'bg-green-500'}`} />
                      <h2 className="text-base font-bold truncate" title={d.id !== d.name ? `Device id: ${d.id}` : undefined}>{d.name}</h2>
                      <button onClick={() => removeDevice(d)} title="Remove from Cloud" className="ml-auto rounded p-1 hover-bg" style={{ color: 'var(--text-secondary)' }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <p className="mt-0.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                      {paused ? 'paused on the device' : !online ? `offline · last seen ${ago(d.lastSeen)}` : d.busy ? 'busy' : 'idle'}
                      {d.deckVersion ? ` · deck v${d.deckVersion}` : ''}
                      {d.computer && <span title={d.os || undefined}> · on {d.computer}</span>}
                    </p>
                    {platforms.length > 0 && (
                      <label className="mt-1 inline-flex items-center gap-1 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
                        <Layers className="h-3 w-3" />
                        <select value={platformOf(d.id)} onChange={(e) => moveTo(d.id, e.target.value)} className="bg-transparent outline-none" title="Which platform this edge belongs to">
                          <option value="">No platform</option>
                          {platforms.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </label>
                    )}
                  </div>
                  <div className="text-right text-xs shrink-0" style={{ color: 'var(--text-secondary)' }}>
                    <div>{d.instruments} instruments</div>
                    <div>
                      {d.workflows} workflows
                      {d.brokenWorkflows > 0 && (
                        <span className="ml-1 inline-flex items-center gap-0.5 text-red-500" title="Won't run on the current deck">
                          <AlertTriangle className="h-3 w-3" />{d.brokenWorkflows}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {d.current ? (
                  <div className="rounded-lg border p-2.5" style={{ borderColor: 'var(--panel-border)' }}>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="font-semibold truncate">{d.current.runName}</span>
                      <span className="shrink-0 text-xs font-bold tabular-nums">{pr ? `${pr.done}/${pr.total}` : d.current.status}</span>
                    </div>
                    {pr && (
                      <>
                        <div className="mt-1.5 h-1.5 rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
                          <div className={`h-full ${pr.state === 'waiting_input' || pr.state === 'paused' ? 'bg-amber-400' : pr.state === 'error' ? 'bg-red-500' : 'bg-yellow-400'}`} style={{ width: `${pct}%` }} />
                        </div>
                        <p className="mt-1 text-[11px] truncate" style={{ color: 'var(--text-secondary)' }}>
                          {[
                            pr.budget ? `iteration ${pr.iteration}/${pr.budget}` : pr.rows_total ? `sample ${Math.min(pr.rows_done + 1, pr.rows_total)}/${pr.rows_total}` : '',
                            pr.state === 'waiting_input' ? 'waiting for input' : pr.state === 'paused' ? 'paused' : pr.state === 'error' ? 'stopped on an error' : pr.step ? String(pr.step).replace(/_/g, ' ') : '',
                          ].filter(Boolean).join(' · ')}
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                    {d.busy ? 'Running something started at the bench.' : 'No Cloud task running.'}
                  </p>
                )}

                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                  <span title="Held in Cloud until this device is free">{d.waiting} waiting in Cloud</span>
                  {d.nextSchedule && (
                    <span className="inline-flex items-center gap-1" title={d.nextSchedule.at}>
                      <CalendarClock className="h-3 w-3" />
                      {d.nextSchedule.name} at {new Date(d.nextSchedule.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )}
                  {d.lastResult && (
                    <a
                      href={`/results?runId=${encodeURIComponent(d.lastResult.runId)}&nodeId=${encodeURIComponent(d.lastResult.nodeId)}`}
                      className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 hover:underline"
                      title={`Last result: ${d.lastResult.name} (${d.lastResult.status})`}
                    >
                      <Table2 className="h-3 w-3" />
                      last result {Number.isNaN(edgeTime(d.lastResult.at)) ? '' : ago(new Date(edgeTime(d.lastResult.at)).toISOString())}
                    </a>
                  )}
                </div>
              </div>
            );
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <header className="glass-header flex shrink-0 items-center justify-between px-6">
        <div className="flex items-center gap-2">
          <Server className="h-5 w-5" />
          <h1 className="text-lg font-semibold">Devices</h1>
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {devices.filter((d) => d.status === 'online').length} of {devices.length} online
          </span>
        </div>
        <div className="flex items-center gap-1">
          <a href="/pair" title="Approve a device showing a pairing code" className="flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium hover-bg" style={{ color: 'var(--text-secondary)' }}>
            <Plus className="h-3.5 w-3.5" /> Pair a device
          </a>
          <button onClick={newPlatform} title="Group edges that work together" className="flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium hover-bg" style={{ color: 'var(--text-secondary)' }}>
            <Plus className="h-3.5 w-3.5" /> New platform
          </button>
          <button onClick={load} title="Refresh" className="rounded p-1.5 hover-bg" style={{ color: 'var(--text-secondary)' }}>
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {claim.length > 0 && (
          <div className="mb-4 rounded-xl border p-4 flex items-center gap-3 text-sm" style={{ borderColor: 'var(--panel-border)' }}>
            <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
            <span className="flex-1">
              {claim.length} device{claim.length === 1 ? ' was' : 's were'} paired before Cloud had sign-in and {claim.length === 1 ? 'is' : 'are'} in no workspace: {claim.join(', ')}.
            </span>
            <button onClick={claimAll} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white bg-blue-500 hover:bg-blue-600">Add to this workspace</button>
          </div>
        )}
        {loaded && devices.length === 0 && claim.length === 0 && (
          <div className="rounded-xl border border-dashed p-8 text-center text-sm" style={{ borderColor: 'var(--panel-border)', color: 'var(--text-secondary)' }}>
            No devices yet. <a href="/pair" className="text-blue-400 hover:underline">Pair a device</a> with the code it shows.
          </div>
        )}
        {groups.map((g) => (
          <section key={g.id ?? 'none'} className="mb-6">
            {(platforms.length > 0 || g.id) && (
              <div className="mb-2 flex items-center gap-2">
                <Layers className="h-4 w-4" style={{ color: 'var(--text-secondary)' }} />
                <h2 className="text-sm font-semibold">{g.name}</h2>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{g.devices.length}</span>
                {g.id && (
                  <>
                    <button title="Rename" onClick={() => renamePlatform(g.id!, g.name)} className="rounded p-1 hover-bg" style={{ color: 'var(--text-secondary)' }}><Pencil className="h-3.5 w-3.5" /></button>
                    <button title="Delete the platform (its devices stay)" onClick={() => deletePlatform(g.id!, g.name)} className="rounded p-1 hover-bg" style={{ color: 'var(--text-secondary)' }}><Trash2 className="h-3.5 w-3.5" /></button>
                  </>
                )}
              </div>
            )}
            {g.devices.length === 0 ? (g.id && (
              <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>No devices yet. Move one here with its Platform menu.</p>
            )) : (
              <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4">
                {g.devices.map(renderDevice)}
              </div>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}