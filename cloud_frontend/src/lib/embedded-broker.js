// A broker this process can *be*, rather than one you have to install first.
//
// LAN mode is documented as needing "no accounts, keys, Docker or internet", but it still meant
// standing up mosquitto by hand — and on Windows that is an elevated edit to a file under Program
// Files, a listener that defaults to loopback only, an `allow_anonymous` that silently flips to
// false the moment you add that listener to fix the first problem, and an inbound firewall rule.
// Every one of those fails quietly. Worse, they fail on a *different port* (1883) from the one
// pairing uses (3002), so the symptom is a device that redeems its code fine and then never
// appears — which reads as a broken device rather than an unreachable broker.
//
// Running the broker in-process removes all of it. It also inherits this process's existing
// inbound firewall permission: Windows program rules cover every port the program listens on,
// which is why the Next app's own port was already reachable from another machine while 1883 was
// not. One fewer thing to get right, and the one that was hardest to diagnose.
//
// Deliberately NOT started when:
//   - cloud mode — AWS IoT Core is the broker, and standing up a second one would be a bug;
//   - MQTT_BROKER_URL points at another machine — that is a deployment saying where its broker
//     lives, and quietly becoming a different broker would be the wrong way to fail;
//   - something already holds the port — almost always a real mosquitto. Deferring to it beats
//     racing it for the socket, and beats guessing which one the edge devices are talking to.
//
// IVORYOS_EMBEDDED_BROKER=0 forces it off, =1 skips the "is this host local" check for the
// unusual case of binding a specific interface on purpose.

const net = require('net');

// Addresses that mean "the broker is on this machine". Note '0.0.0.0' is in here: as a *connect*
// target it is meaningless, but people write it in config meaning "listen everywhere", and
// treating it as remote would be a confusing way to refuse.
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '0.0.0.0', ''];

function parseBrokerUrl(brokerUrl) {
  const u = new URL(brokerUrl);
  return { host: u.hostname, port: Number(u.port) || 1883 };
}

/**
 * Resolves to { started, port?, reason?, close? }. Never rejects and never throws: a broker we
 * could not start is a thing to report and carry on from (an external one may well be running),
 * not a reason to take the daemon down.
 */
async function startEmbeddedBroker(brokerUrl) {
  if (process.env.IVORYOS_EMBEDDED_BROKER === '0') {
    return { started: false, reason: 'disabled by IVORYOS_EMBEDDED_BROKER=0' };
  }
  if (process.env.AWS_IOT_ENDPOINT) {
    return { started: false, reason: 'cloud mode — AWS IoT Core is the broker' };
  }

  let host, port;
  try {
    ({ host, port } = parseBrokerUrl(brokerUrl));
  } catch {
    return { started: false, reason: `could not parse broker url "${brokerUrl}"` };
  }

  if (!LOCAL_HOSTS.includes(host) && process.env.IVORYOS_EMBEDDED_BROKER !== '1') {
    return { started: false, reason: `${host} is not this machine` };
  }

  let aedes;
  try {
    const { Aedes } = require('aedes');
    // MUST be the async factory, never `new Aedes()`. A directly constructed instance is not
    // finished initialising, and it fails silently in the worst way: the TCP connection is
    // accepted and then no CONNACK is ever sent, so every client — including this daemon's own —
    // hangs until its keepalive gives up. It looks exactly like an unreachable broker.
    aedes = await Aedes.createBroker();
  } catch (e) {
    return { started: false, reason: `aedes unavailable: ${e.message}` };
  }

  return new Promise((resolve) => {
    const server = net.createServer(aedes.handle);

    server.once('error', (e) => {
      const reason = e.code === 'EADDRINUSE'
        ? `port ${port} is already served by another broker`
        : e.message;
      aedes.close(() => resolve({ started: false, reason }));
    });

    // Always 0.0.0.0, never the host parsed above. "127.0.0.1" in config means "the broker is on
    // this machine" — it does not mean "refuse every device on the LAN". Binding what was written
    // there instead is precisely the mosquitto default that made this painful in the first place,
    // and it is not a mistake worth reproducing faithfully.
    server.listen(port, '0.0.0.0', () => {
      resolve({
        started: true,
        port,
        close: () => new Promise((done) => server.close(() => aedes.close(done))),
      });
    });
  });
}

module.exports = { startEmbeddedBroker };
