import { NextResponse } from 'next/server';
import { getStore, resolveMode, resolveBrokerUrl } from '@/lib/store';

export const dynamic = 'force-dynamic';

// A device list can be empty for four very different reasons — the daemon isn't running, the
// broker is unreachable, the store is misconfigured, or there genuinely are no devices yet — and
// until now all four rendered as the same "0 Edges Online" badge. That ambiguity cost real
// debugging time, so this route reports each link separately and the header badge reflects it.
//
// `staleAfterMs` is 3x the daemon's 5s heartbeat: long enough that one slow write or a GC pause
// doesn't flap the UI, short enough to notice a dead daemon quickly.
const HEARTBEAT_STALE_MS = 15000;

export async function GET() {
  const mode = (() => {
    try { return resolveMode(); } catch { return 'unknown'; }
  })();

  const health: any = {
    mode,
    brokerUrl: resolveBrokerUrl(),
    store: { ok: false, backend: null as string | null },
    daemon: { ok: false, running: false, brokerConnected: false },
    devices: { total: 0, online: 0 },
    problems: [] as string[],
  };

  let store;
  try {
    store = getStore();
    health.store.backend = store.backend;
    await store.ping();
    health.store.ok = true;
    health.store.location = store.location;
  } catch (e: any) {
    health.store.error = e.message;
    // Nothing else can be known without the store — the daemon reports its liveness through it.
    health.problems.push(
      mode === 'cloud'
        ? `Cannot reach Supabase: ${e.message}`
        : `Cannot open the local database: ${e.message}`,
    );
    return NextResponse.json(health, { status: 503 });
  }

  try {
    const beat = await store.getDaemonHeartbeat();
    if (!beat || !beat.lastSeen) {
      health.problems.push('The daemon has never checked in. Start it with: npm run daemon');
    } else {
      const ageMs = Date.now() - new Date(beat.lastSeen).getTime();
      health.daemon.lastSeen = beat.lastSeen;
      health.daemon.ageMs = ageMs;
      health.daemon.brokerUrl = beat.brokerUrl;
      health.daemon.running = ageMs < HEARTBEAT_STALE_MS;
      health.daemon.brokerConnected = health.daemon.running && beat.brokerConnected;
      health.daemon.ok = health.daemon.running && health.daemon.brokerConnected;

      if (!health.daemon.running) {
        health.problems.push(
          `The daemon stopped responding ${Math.round(ageMs / 1000)}s ago. Restart it with: npm run daemon`,
        );
      } else if (!health.daemon.brokerConnected) {
        health.problems.push(`The daemon is running but not connected to the broker at ${beat.brokerUrl}.`);
      }

      // Both processes resolve the store path independently, and in LAN mode they can disagree
      // (bundler-rewritten __dirname, or a different cwd depending on how each was launched).
      // When they do, everything looks healthy and the device list is simply always empty,
      // because the daemon is writing a file the app never reads. This turns the worst kind of
      // silent failure into a named one. Only meaningful if the daemon is actually alive — a
      // stale row's path says nothing about now.
      health.daemon.storeLocation = beat.storeLocation;
      if (health.daemon.running && beat.storeLocation && store.location
          && beat.storeLocation !== store.location) {
        health.problems.push(
          `The app and the daemon are using different databases — the app reads "${store.location}" `
          + `but the daemon writes "${beat.storeLocation}". Set IVORYOS_LOCAL_DB to the same `
          + `absolute path for both, or start both from the same directory.`,
        );
      }
    }
  } catch (e: any) {
    health.problems.push(`Could not read the daemon heartbeat: ${e.message}`);
  }

  try {
    const devices = await store.listDevices();
    health.devices.total = devices.length;
    health.devices.online = devices.filter((d: any) => String(d.status) === 'online').length;

    // Paired, but never once seen. Pairing and running are two different connections to two
    // different ports: redeeming a code only proves the device reached this app over HTTP, while
    // everything afterwards rides MQTT. When just the first half succeeds the device registers
    // and then never appears again — and with no check for it, that read as a healthy backend
    // beside an idle lab, which is the single thing it was definitely not. A device that has ever
    // been seen is excluded: it has a real `last_seen`, so it is offline, not unreachable.
    const neverSeen = devices.filter((d: any) => !d.last_seen).map((d: any) => String(d.id));
    if (neverSeen.length) {
      health.devices.neverSeen = neverSeen;
      health.problems.push(
        `${neverSeen.length === 1 ? 'Device' : 'Devices'} ${neverSeen.join(', ')} paired but never `
        + `connected to the broker at ${health.brokerUrl}. Pairing itself succeeded, so the broker `
        + `is the half that is unreachable from the device: check it listens on a LAN address `
        + `rather than loopback, and that its port is open in the firewall.`,
      );
    }
  } catch (e: any) {
    health.problems.push(`Could not list devices: ${e.message}`);
  }

  if (!health.problems.length && health.devices.total === 0) {
    // Not a failure — everything is up and simply nothing has connected. Said explicitly so the
    // UI can distinguish it from the failure cases above rather than inferring from a zero.
    health.note = 'Backend healthy — no edge devices have connected yet.';
  }

  health.ok = health.problems.length === 0;
  return NextResponse.json(health);
}
