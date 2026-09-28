import json
import ssl
import time
import asyncio
from collections import deque
import paho.mqtt.client as mqtt
from typing import Callable, Any, Coroutine

class MessageBroker:
    def __init__(self, client_id: str):
        self.client_id = client_id
        self.on_message_callback = None

    def set_callback(self, callback: Callable[[str, dict], Coroutine[Any, Any, None]]):
        self.on_message_callback = callback

    def connect(self):
        raise NotImplementedError

    def disconnect(self):
        raise NotImplementedError

    def publish(self, topic: str, payload: dict, retain: bool = False, qos: int = 0):
        raise NotImplementedError

    def subscribe(self, topic: str):
        raise NotImplementedError

    def set_will(self, topic: str, payload: dict, retain: bool = False):
        raise NotImplementedError


class LocalMQTTBroker(MessageBroker):
    def __init__(self, client_id: str, host: str, port: int = 1883):
        super().__init__(client_id)
        self.host = host
        self.port = port

        # Determine Paho API version (support v2 and v1)
        try:
            self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id)
        except AttributeError:
            self.client = mqtt.Client(client_id)

        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.on_disconnect = self._on_disconnect
        self.loop = None
        # Drops this client did not ask for, for link_health(). See _on_disconnect.
        self._drops = deque(maxlen=20)
        self._closing = False
        self._flapping_reported = False
        # Topics to (re)subscribe on every connect; see _resubscribe.
        self._subscriptions = []
        # (own status topic, own session) once watch_identity() is called, and when another
        # process last announced itself under this identity: (time, its session).
        self._identity = None
        self._foreign = None

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            print(f"Connected to MQTT Broker at {self.host}:{self.port}")
            self._resubscribe()
        else:
            print(f"Failed to connect to MQTT broker, return code {rc}")

    def _resubscribe(self):
        # A clean session (the default) means the broker forgets this client's subscriptions
        # when it disconnects, and paho does not restore them on its automatic reconnect. Without
        # this, one dropped connection (a network blip, a broker restart, another copy taking the
        # identity over) left the edge online but deaf: no Cloud tasks, no workflow pushes, until
        # it was restarted.
        for topic in self._subscriptions:
            self.client.subscribe(topic)
        self._announce()

    def _announce(self):
        # Every connect says "this session holds the identity now", retained, so a second copy
        # sharing the id finds it the moment it next connects (see watch_identity).
        if self._identity:
            self.client.publish(self._identity[0], json.dumps({"session": self._identity[1], "ts": time.time()}), qos=1, retain=True)

    # Three unrequested drops inside this window is not a flaky network, it is a pattern: MQTT
    # allows one connection per client id, so a second client with the same id (a second copy of
    # this edge sharing its .env pairing) is let in by evicting this one, which reconnects and
    # evicts it in turn, about once a second. MQTT 3.1.1 gives no reason code for a takeover (the
    # broker just closes the socket), so the pattern is the only signal there is.
    FLAP_WINDOW_S = 30.0
    FLAP_DROPS = 3

    def link_health(self) -> dict:
        now = time.time()
        recent = sum(1 for t in self._drops if now - t < self.FLAP_WINDOW_S)
        other = self._foreign[1] if self._foreign and now - self._foreign[0] < self.FLAP_WINDOW_S else None
        return {
            "connected": self.client.is_connected(),
            "recent_drops": recent,
            "flapping": recent >= self.FLAP_DROPS,
            # A live heartbeat under this identity from another process: the certain signal,
            # seen by both copies (the drop pattern above is only seen by the one being evicted).
            "other_session": other,
        }

    def watch_identity(self, presence_topic: str, session: str):
        """Announce this process on its own presence topic, and notice announcements that are not ours.

        Two clients with one id are almost never connected at the same moment (each evicts the
        other), so live messages between them rarely arrive. What does: each copy publishes a
        retained {session, ts} every time it connects (_announce), and the broker replays it to
        the other copy when that one reconnects and resubscribes. So both copies see it, within
        one round of evictions. A retained announcement can also be this edge's own previous run
        (a restart), so one only counts if it was sent after this process started.

        A topic of its own rather than the status heartbeat: Cloud reads `busy` from that one,
        and a heartbeat without it would briefly mark the device busy on every reconnect."""
        self._identity = (presence_topic, session)
        self._identity_since = time.time()
        self.subscribe(presence_topic)
        self._announce()

    def _on_disconnect(self, client, userdata, *args):
        if not self._closing:
            self._drops.append(time.time())
            if self.link_health()["flapping"]:
                # Back off: two copies taking turns every second is a storm of connections and
                # republished state; a slower one lets whichever reconnects first stay connected.
                self.client.reconnect_delay_set(min_delay=15, max_delay=120)
                if not self._flapping_reported:
                    self._flapping_reported = True
                    print(f"Cloud link keeps dropping right after connecting. Is another edge using the "
                          f"same Cloud identity ({self.client_id}), e.g. a second copy of this script "
                          f"started from the same folder? Reconnecting more slowly.")

        # *args absorbs both paho v1 (rc) and v2 (DisconnectFlags, ReasonCode, properties) call
        # shapes. Kept deliberately minimal — this exists for connection-stability visibility
        # (e.g. spotting an unexpected disconnect loop), not routine noise on every reconnect.
        # If this fires repeatedly in rapid succession (sub-2s intervals) without
        # LocalMQTTBroker.disconnect() ever being called, it's not application code — see
        # AGENTS.md's Cloud section for how this was root-caused to a local network issue
        # (VPN/security software interfering with the long-lived TLS connection), not a bug here.
        print(f"Disconnected from broker at {self.host}:{self.port}")

    def set_will(self, topic: str, payload: dict, retain: bool = False):
        """Registers a Last Will and Testament: the broker publishes this on our behalf if we
        disconnect uncleanly (crash, network loss). retain defaults to False because AWS IoT Core
        silently refuses the entire CONNECT (no CONNACK, ever — just hangs until the client times
        out) if the Last Will has retain=True; confirmed by direct testing against a live AWS IoT
        endpoint, request logs show no rejection reason. A plain local MQTT broker (Mosquitto etc.)
        has no such restriction, which is why this only breaks against real AWS IoT. Practical
        effect: the will only reaches subscribers who are already connected at the moment we drop
        — anyone who (re)subscribes afterward won't see it. status_loop's periodic retained
        'online' publish plus daemon.js's own staleness sweep (no update in 15s -> mark offline)
        is what actually catches the "subscriber wasn't watching live" case. Must be called before
        connect()."""
        self.client.will_set(topic, json.dumps(payload, default=str), qos=1, retain=retain)

    def _on_message(self, client, userdata, msg):
        if self._identity and msg.topic == self._identity[0]:
            # Our own presence topic (watch_identity): never a message for the app.
            try:
                beat = json.loads(msg.payload.decode('utf-8'))
            except Exception:
                return
            if not isinstance(beat, dict):
                return
            session = beat.get("session")
            sent = beat.get("ts")
            fresh = not msg.retain or (isinstance(sent, (int, float)) and sent >= self._identity_since)
            if fresh and session and session != self._identity[1]:
                if not self._foreign:
                    print(f"Another edge is connecting as this Cloud device ({self.client_id}, "
                          f"session {session}): a second copy running with the same pairing.")
                self._foreign = (time.time(), session)
            return
        try:
            payload = json.loads(msg.payload.decode('utf-8'))
            if self.on_message_callback and self.loop:
                # Schedule the async callback on the main event loop safely
                asyncio.run_coroutine_threadsafe(
                    self.on_message_callback(msg.topic, payload), 
                    self.loop
                )
        except Exception as e:
            print(f"Failed to process message from {msg.topic}: {e}")

    def connect(self):
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            pass # We'll set this later if missing
        self.client.connect(self.host, self.port, 60)
        self.client.loop_start()

    def disconnect(self):
        self._closing = True
        self.client.loop_stop()
        self.client.disconnect()

    def publish(self, topic: str, payload: dict, retain: bool = False, qos: int = 0):
        self.client.publish(topic, json.dumps(payload, default=str), qos=qos, retain=retain)

    def subscribe(self, topic: str):
        if topic not in self._subscriptions:
            self._subscriptions.append(topic)
        self.client.subscribe(topic)
        print(f"Subscribed to {topic}")


class AWSIoTBroker(LocalMQTTBroker):
    def __init__(self, client_id: str, endpoint: str, ca_cert: str, certfile: str, keyfile: str):
        super().__init__(client_id, endpoint, 8883)
        self.client.tls_set(
            ca_certs=ca_cert, 
            certfile=certfile, 
            keyfile=keyfile, 
            cert_reqs=ssl.CERT_REQUIRED, 
            tls_version=ssl.PROTOCOL_TLSv1_2, 
            ciphers=None
        )
        
    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            print(f"Connected securely to AWS IoT Core at {self.host}")
            self._resubscribe()
        else:
            print(f"Failed to connect to AWS IoT Core, return code {rc}")
