import { getStore, resolveMode, resolveBrokerUrl } from '@/lib/store';
import { provisionDevice } from '@/lib/aws-iot';

/**
 * The broker address to hand the device, which is not necessarily the one this Cloud uses itself.
 *
 * In cloud mode it is fixed — AWS_IOT_ENDPOINT, the same for every device, nothing to infer.
 *
 * In LAN mode the daemon may well be talking to 127.0.0.1, which is meaningless on another
 * machine. But the device just told us a working address for free: whatever host it used to reach
 * this route is, by construction, an address that resolves from where the device is. So derive it
 * from the request rather than asking anyone to configure it.
 */
function brokerForDevice(req: Request, stored: { host?: string; port?: number } | null | undefined) {
  if (process.env.AWS_IOT_ENDPOINT) {
    return { protocol: 'aws_iot' as const, endpoint: process.env.AWS_IOT_ENDPOINT, port: 8883 };
  }

  // The broker the daemon itself uses: the one chosen in Settings, else MQTT_BROKER_URL, the same
  // fallback as the daemon (store/index.js resolveBrokerUrl). Assuming 1883 here sent devices to
  // whatever else was listening on 1883 whenever the Cloud's broker was on another port.
  let fallback = { host: '', port: 1883 };
  try {
    const u = new URL(resolveBrokerUrl());
    fallback = { host: u.hostname, port: Number(u.port) || 1883 };
  } catch { /* a malformed URL: the daemon cannot connect either, and /api/health says so */ }
  const storedHost = stored?.host?.trim();
  const configured = storedHost || fallback.host;
  const port = storedHost ? (stored?.port || 1883) : fallback.port;
  const isLoopback = !configured
    || configured === '127.0.0.1'
    || configured === 'localhost'
    || configured === '::1'
    || configured === '0.0.0.0';

  let endpoint = configured;
  if (isLoopback) {
    // Host header minus the port; it is the address the device successfully connected to.
    const host = (req.headers.get('host') || '').split(':')[0];
    endpoint = host && host !== 'localhost' && host !== '127.0.0.1' ? host : '127.0.0.1';
  }
  return { protocol: 'mqtt' as const, endpoint, port };
}

/**
 * Mint one device's identity and its connection token (the CLOUD_TOKEN the edge's setup_broker
 * reads). The only place a device identity is created. On AWS that is a Thing plus a certificate,
 * and the private key in the token exists only here and on the device it is sent to, once.
 *
 * `deviceId` is the device's lasting identity (its MQTT client id, and on AWS its Thing name);
 * issuing for an id Cloud already has reattaches that device with fresh credentials. `req` is the
 * edge's own request, which on a LAN is what tells us the broker address it can reach.
 */
export async function issueDeviceCredentials(req: Request, deviceId: string, deviceName: string) {
  const store = getStore();
  const topicPrefix = process.env.MQTT_TOPIC_PREFIX || 'ivoryos/edge';
  const broker = brokerForDevice(req, await store.getBrokerConfig());

  let token: string;
  if (broker.protocol === 'aws_iot') {
    // A real Thing + certificate: the expensive, billable half of pairing, reachable only after a
    // signed-in person approved the request. For a Thing that already exists (the same device
    // paired again) this issues a new certificate and revokes the old ones.
    token = (await provisionDevice(deviceId)).token;
  } else {
    token = Buffer.from(JSON.stringify({
      protocol: 'mqtt',
      endpoint: broker.endpoint,
      port: broker.port,
      client_id: deviceId,
      topic_prefix: topicPrefix,
    })).toString('base64');
  }
  // Listed at once, as "paired, never seen", rather than only after its first heartbeat.
  await store.upsertDevicePlaceholder(deviceId, deviceName);

  return {
    token,
    deviceId,
    mode: resolveMode(),
    broker: `${broker.protocol === 'aws_iot' ? 'mqtts' : 'mqtt'}://${broker.endpoint}:${broker.port}`,
  };
}
