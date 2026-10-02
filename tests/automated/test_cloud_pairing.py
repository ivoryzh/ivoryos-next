"""Pairing with Cloud (ivoryos_edge/cloud_pairing.py) and the credentials it leaves on disk.

The edge shows a code and waits; a person approves it on Cloud; only the secret this process kept
collects the token. What is pinned here: the polling ends only on Cloud's final answer or expiry,
the secret never reaches a page, no other website can start pairing, and the token and AWS
certificates are written exactly as issued and readable by this user only.
"""
import asyncio
import base64
import json
import os
import ssl
import sys

import httpx
import pytest
from fastapi.testclient import TestClient

from ivoryos_edge import cloud_pairing, server


def run(coro):
    return asyncio.run(coro)


class FakeCloud:
    """Answers /api/pair/start and /api/pair/poll from a script of poll replies."""

    def __init__(self, polls):
        self.polls = list(polls)
        self.started = []
        self.polled = []

    def handler(self, request: httpx.Request):
        body = json.loads(request.content or b"{}")
        if request.url.path == "/api/pair/start":
            self.started.append(body)
            return httpx.Response(200, json={
                "code": "7K4M-9QX2", "secret": "s" * 43, "expiresAt": "2099-01-01T00:00:00.000Z",
                "interval": 3, "approveUrl": "http://cloud.test/pair?code=7K4M-9QX2",
            })
        self.polled.append(body)
        reply = self.polls.pop(0)
        if isinstance(reply, Exception):
            raise reply
        status, payload = reply
        return httpx.Response(status, json=payload)

    def client(self):
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler), base_url="http://cloud.test")


def pair_with(cloud, clock=lambda: 0.0):
    slept = []

    async def sleep(seconds):
        slept.append(seconds)

    async def go():
        async with cloud.client() as client:
            pairing = await cloud_pairing.start("http://cloud.test", "Flow rig", ["pump"], client=client)
            token = await cloud_pairing.wait_for_token(pairing, client=client, sleep=sleep, clock=clock)
            return pairing, token

    pairing, token = run(go())
    return pairing, token, slept


def test_waits_until_approved_and_polls_with_the_secret_only():
    cloud = FakeCloud([(200, {"status": "waiting"}), (200, {"status": "waiting"}),
                       (200, {"status": "approved", "token": "TOKEN"})])
    pairing, token, slept = pair_with(cloud)
    assert token == "TOKEN" and pairing.state == "approved"
    assert cloud.started == [{"name": "Flow rig", "instruments": ["pump"]}]
    assert all(p == {"secret": "s" * 43} for p in cloud.polled)
    assert slept == [3, 3]
    described = json.dumps(pairing.describe())
    assert "7K4M-9QX2" in described and "s" * 43 not in described, "pages see the code, never the secret"


@pytest.mark.parametrize("status,state", [("denied", "denied"), ("expired", "expired"), ("used", "error"), ("unknown", "error")])
def test_cloud_final_answers_end_it(status, state):
    code = 404 if status == "unknown" else 410
    pairing, token, _ = pair_with(FakeCloud([(code, {"status": status, "error": f"it was {status}"})]))
    assert token is None and pairing.state == state and pairing.error == f"it was {status}"


def test_an_unreachable_or_failing_cloud_is_waited_out():
    cloud = FakeCloud([
        httpx.ConnectError("down"),
        (500, {"status": "waiting", "error": "AWS said no"}),
        (429, {"status": "waiting"}),
        (200, {"status": "approved", "token": "TOKEN"}),
    ])
    pairing, token, slept = pair_with(cloud)
    assert token == "TOKEN"
    # an outage waits at least 5 s, a provisioning failure 15 s (each retry is a real attempt),
    # too many requests three intervals
    assert slept == [5, 15, 9]


def test_a_code_nobody_approves_expires_locally_too():
    cloud = FakeCloud([(200, {"status": "waiting"})] * 3)
    clock = iter([0.0, 10.0, 5e9]).__next__
    pairing, token, _ = pair_with(cloud, clock=clock)
    assert token is None and pairing.state == "expired"


def test_an_unreachable_cloud_says_which_address():
    async def go():
        transport = httpx.MockTransport(lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")))
        async with httpx.AsyncClient(transport=transport) as client:
            await cloud_pairing.start("192.168.1.20:3000", "rig", [], client=client)
    with pytest.raises(cloud_pairing.PairingError, match=r"http://192\.168\.1\.20:3000"):
        run(go())


# --- the credentials on disk -----------------------------------------------------------------

def test_the_token_file_keeps_other_settings(tmp_path):
    env = tmp_path / ".env"
    env.write_text("IVORYOS_PORT=8081\nCLOUD_TOKEN=old\nOTHER=1\n")
    cloud_pairing.save_token(str(env), "new")
    assert env.read_text().splitlines() == ["IVORYOS_PORT=8081", "OTHER=1", "CLOUD_TOKEN=new"]
    if sys.platform != "win32":
        assert (env.stat().st_mode & 0o777) == 0o600


def _self_signed(tmp_path):
    """A certificate and key in PEM, from `cryptography` if installed, else the openssl command."""
    try:
        import cryptography  # noqa: F401
    except ImportError:
        import shutil
        import subprocess
        openssl = shutil.which("openssl")
        if not openssl:
            pytest.skip("needs the cryptography package or the openssl command")
        key, cert = tmp_path / "gen.key", tmp_path / "gen.crt"
        subprocess.run([openssl, "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                        "-subj", "/CN=edge-test", "-keyout", str(key), "-out", str(cert)],
                       check=True, capture_output=True)
        return cert.read_text(), key.read_text()
    from datetime import datetime, timedelta, timezone
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "edge-test")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now).not_valid_after(now + timedelta(days=1))
            .sign(key, hashes.SHA256()))
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    key_pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                serialization.NoEncryption()).decode()
    return cert_pem, key_pem


def test_aws_certificates_are_written_exactly_and_privately(tmp_path):
    cert_pem, key_pem = _self_signed(tmp_path)
    ca, cert, key = cloud_pairing.write_aws_certificates(
        {"root_ca": cert_pem, "cert_pem": cert_pem, "private_key": key_pem}, str(tmp_path / ".certs"))
    # Byte for byte: text mode on Windows would have rewritten every line ending.
    assert open(key, "rb").read() == key_pem.encode()
    assert b"\r\n" not in open(cert, "rb").read()
    # What the MQTT client does with them: they load as a certificate chain and a trust root.
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.load_cert_chain(cert, key)
    context.load_verify_locations(ca)
    if sys.platform != "win32":
        assert (os.stat(key).st_mode & 0o777) == 0o600
        assert (os.stat(tmp_path / ".certs").st_mode & 0o777) == 0o700


def test_an_incomplete_aws_token_is_refused_with_a_reason(tmp_path):
    with pytest.raises(ValueError, match="private_key"):
        cloud_pairing.write_aws_certificates(
            {"root_ca": "-----BEGIN CERTIFICATE-----", "cert_pem": "-----BEGIN CERTIFICATE-----"}, str(tmp_path))
    assert not os.path.exists(tmp_path / "device.private.key"), "nothing half-written"


def test_connecting_with_an_aws_token_uses_the_certificates_it_carries(tmp_path, monkeypatch):
    certs = {"root_ca": "-----BEGIN CERTIFICATE-----\nCA\n", "cert_pem": "-----BEGIN CERTIFICATE-----\nC\n",
             "private_key": "-----BEGIN RSA PRIVATE KEY-----\nK\n"}
    token = base64.b64encode(json.dumps({
        "protocol": "aws_iot", "endpoint": "abc-ats.iot.us-east-1.amazonaws.com",
        "client_id": "flow-rig-x1y2z3", "topic_prefix": "ivoryos/edge", "certs": certs,
    }).encode()).decode()
    seen = {}

    class FakeAWS:
        def __init__(self, client_id, endpoint, ca, cert, key):
            seen.update(client_id=client_id, endpoint=endpoint, files=[open(p).read() for p in (ca, cert, key)])

        def set_callback(self, *a):
            pass

        def set_will(self, *a, **k):
            pass

        def connect(self):
            raise ConnectionRefusedError("no network in tests")

        def disconnect(self):
            pass

    monkeypatch.setattr(server, "AWSIoTBroker", FakeAWS)
    monkeypatch.setattr(server, "CERTS_DIR", str(tmp_path / ".certs"))
    monkeypatch.setattr(server, "CLOUD_TOKEN", token)
    monkeypatch.setattr(server, "global_broker", None)
    run(server.setup_broker())
    assert seen["client_id"] == "flow-rig-x1y2z3"
    assert seen["endpoint"] == "abc-ats.iot.us-east-1.amazonaws.com"
    assert seen["files"] == [certs["root_ca"], certs["cert_pem"], certs["private_key"]]
    assert server.cloud_connection_state == "error" and "no network" in server.cloud_connection_error


# --- the edge's endpoints ----------------------------------------------------------------------

@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setattr(server, "ENV_PATH", str(tmp_path / ".env"))
    monkeypatch.setattr(server, "cloud_pairing_session", None)
    return TestClient(server.app)  # no startup: no deck, no broker


@pytest.mark.parametrize("origin", ["https://evil.example", "null"])
def test_other_websites_cannot_pair_or_set_the_token(client, origin):
    headers = {"Origin": origin}
    assert client.post("/api/cloud-settings/pair", json={"cloud_url": "https://evil.example"}, headers=headers).status_code == 403
    assert client.post("/api/cloud-settings", json={"token": "x"}, headers=headers).status_code == 403
    assert client.delete("/api/cloud-settings/pair", headers=headers).status_code == 403


def test_starting_pairing_shows_the_code_and_never_the_secret(client, monkeypatch):
    started = {}

    async def fake_start(cloud_url, name, instruments, device_id=None):
        started.update(cloud_url=cloud_url, name=name, device_id=device_id)
        return cloud_pairing.Pairing(cloud_url or "https://cloud.test", "7K4M-9QX2", "secret-value-" * 4,
                                     "https://cloud.test/pair?code=7K4M-9QX2", None, 3)

    async def never(pairing):
        await asyncio.sleep(3600)

    monkeypatch.setattr(cloud_pairing, "start", fake_start)
    monkeypatch.setattr(server, "_finish_pairing", never)
    for origin in (None, "ivoryos-app://ui", "http://localhost:3001", "http://testserver"):
        res = client.post("/api/cloud-settings/pair", json={"name": "Flow rig"}, headers={"Origin": origin} if origin else {})
        assert res.status_code == 200, (origin, res.text)
    assert res.json()["code"] == "7K4M-9QX2" and started["name"] == "Flow rig"
    # Every attempt offers Cloud the same lasting identity, made from the first name it had.
    assert started["device_id"].startswith("flow-rig-")
    assert cloud_pairing.read_env(server.ENV_PATH)["CLOUD_DEVICE_ID"] == started["device_id"]
    settings = client.get("/api/cloud-settings").json()
    assert settings["pairing"]["state"] == "waiting"
    assert "secret-value" not in json.dumps(settings) and "secret-value" not in res.text
    assert client.delete("/api/cloud-settings/pair").json() == {"status": "cancelled"}
    assert client.get("/api/cloud-settings").json()["pairing"] is None


def test_lan_token_login_reaches_the_mqtt_client():
    """A LAN Cloud's token carries the device's broker login (Cloud's brokerAuth.js); the edge must
    sign in with it, and an older token without one must still build a client."""
    import base64
    import json as _json
    from ivoryos_edge import server

    token = base64.b64encode(_json.dumps({
        "protocol": "mqtt", "endpoint": "10.0.0.5", "port": 1883, "client_id": "rig-1",
        "topic_prefix": "ivoryos/edge", "username": "rig-1", "password": "s3cret",
    }).encode()).decode()
    broker, prefix, client_id, url = server._broker_from_token(token)
    assert (client_id, prefix, url) == ("rig-1", "ivoryos/edge", "mqtt://10.0.0.5:1883")
    assert broker.client._username == b"rig-1" and broker.client._password == b"s3cret"

    old = base64.b64encode(_json.dumps({"protocol": "mqtt", "endpoint": "10.0.0.5", "client_id": "rig-1"}).encode()).decode()
    assert server._broker_from_token(old)[0].client._username is None


def test_a_refused_login_says_pair_again():
    import asyncio
    from ivoryos_edge import server
    from ivoryos_edge.broker import LocalMQTTBroker

    broker = LocalMQTTBroker("rig-1", "127.0.0.1", 1883, username="rig-1", password="old")
    broker.refused = 4  # what paho reports for a bad username or password
    try:
        asyncio.run(server._wait_connected(broker, seconds=0.3))
    except PermissionError as e:
        assert "pair it again" in str(e).lower()
    else:
        raise AssertionError("a refused login must not wait out the timeout as if unreachable")
