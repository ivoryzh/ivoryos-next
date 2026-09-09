import json
import ssl
import asyncio
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
        self.loop = None

    def _on_connect(self, client, userdata, flags, rc, properties=None):
        if rc == 0:
            print(f"Connected to MQTT Broker at {self.host}:{self.port}")
        else:
            print(f"Failed to connect to MQTT broker, return code {rc}")

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
        self.client.loop_stop()
        self.client.disconnect()

    def publish(self, topic: str, payload: dict, retain: bool = False, qos: int = 0):
        self.client.publish(topic, json.dumps(payload, default=str), qos=qos, retain=retain)

    def subscribe(self, topic: str):
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
        else:
            print(f"Failed to connect to AWS IoT Core, return code {rc}")
