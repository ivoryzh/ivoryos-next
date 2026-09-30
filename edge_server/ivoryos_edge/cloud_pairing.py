"""Pairing this edge with IvoryOS Cloud: show a code, wait for a person to approve it on Cloud.

    start()           asks Cloud for a code; keeps the secret that proves this edge started it
    wait_for_token()  polls with that secret until someone approves (then returns the token),
                      declines, or the code expires

The code only lets a signed-in person *approve* this device; the credentials go to whoever holds
the secret, which never leaves this process (Cloud keeps only its hash). See
cloud_frontend/src/lib/pairing.js for Cloud's side.

This module is deliberately light (httpx only): `ivoryos-edge pair` uses it without starting the
server, and the server uses it for the Cloud Connect page and the desktop app.

It also owns writing the credentials to disk (`save_token`, `write_private_file`), because the
token, and on AWS the certificate files written from it, carry this device's private key.
"""

from __future__ import annotations

import asyncio
import os
import time
from datetime import datetime, timezone
from typing import Any, Callable, Optional

import httpx

# A hosted Cloud is at a fixed address the edge ships with; only a lab's own Cloud needs one typed
# in. IVORYOS_CLOUD_URL overrides it for staging or self-hosting.
DEFAULT_CLOUD_URL = os.getenv("IVORYOS_CLOUD_URL", "https://cloud.ivoryos.ai")

# Final states: nothing more will happen without starting again.
FINAL = ("connected", "denied", "expired", "error", "cancelled")


class PairingError(Exception):
    pass


def _parse_time(value: Any) -> Optional[float]:
    if not value:
        return None
    try:
        # Python 3.10's fromisoformat does not accept the trailing Z JavaScript writes.
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


class Pairing:
    """One attempt. `describe()` is what pages see; the secret is never part of it."""

    def __init__(self, cloud_url: str, code: str, secret: str, approve_url: str,
                 expires_at: Optional[float], interval: float):
        self.cloud_url = cloud_url
        self.code = code
        self.approve_url = approve_url
        self.expires_at = expires_at
        self.interval = max(1.0, float(interval or 3))
        self.state = "waiting"  # waiting -> approved -> connected, or denied / expired / error / cancelled
        self.error: Optional[str] = None
        self._secret = secret

    def describe(self) -> dict:
        expires = self.expires_at
        return {
            "state": self.state,
            "code": self.code,
            "approve_url": self.approve_url,
            "cloud_url": self.cloud_url,
            "expires_at": datetime.fromtimestamp(expires, timezone.utc).isoformat().replace("+00:00", "Z") if expires else None,
            "error": self.error,
        }


def normalize_cloud_url(url: str) -> str:
    url = (url or DEFAULT_CLOUD_URL).strip().rstrip("/")
    if url and "://" not in url:
        url = f"http://{url}"
    return url


async def start(cloud_url: str, name: str, instruments: list[str],
                client: Optional[httpx.AsyncClient] = None, device_id: Optional[str] = None) -> Pairing:
    """Ask Cloud for a code. Raises PairingError with a message fit to show a person.
    `device_id` is this device's lasting identity (ensure_device_id): pairing with it again
    reattaches the same device on Cloud."""
    cloud_url = normalize_cloud_url(cloud_url)
    own = client is None
    client = client or httpx.AsyncClient(timeout=20)
    try:
        body = {"name": name, "instruments": instruments}
        if device_id:
            body["device_id"] = device_id
        resp = await client.post(f"{cloud_url}/api/pair/start", json=body)
        data = resp.json()
    except Exception as e:
        # Reaching Cloud over HTTP is pairing's one prerequisite, and on a LAN a wrong address is
        # the likeliest mistake, so say which address failed.
        raise PairingError(f"Could not reach Cloud at {cloud_url}: {e}") from e
    finally:
        if own:
            await client.aclose()
    if resp.status_code != 200 or not data.get("secret"):
        raise PairingError(data.get("error") or f"Cloud at {cloud_url} refused to start pairing ({resp.status_code}).")
    return Pairing(cloud_url, data["code"], data["secret"], data.get("approveUrl") or f"{cloud_url}/pair",
                   _parse_time(data.get("expiresAt")), data.get("interval") or 3)


async def wait_for_token(pairing: Pairing, client: Optional[httpx.AsyncClient] = None,
                         sleep: Callable = asyncio.sleep, clock: Callable[[], float] = time.time) -> Optional[str]:
    """Poll until approved (returns the token) or finished otherwise (returns None; see state/error).

    A Cloud that is briefly unreachable, or busy, is waited out rather than ending the attempt: the
    person may be halfway through approving it. Only Cloud's own final answer, or the code's
    expiry, stops it.
    """
    own = client is None
    client = client or httpx.AsyncClient(timeout=30)
    try:
        while pairing.state == "waiting":
            # Cloud restarts the clock when the request is approved, and says so in each answer;
            # the local check is only a backstop against a Cloud that has gone for good.
            if pairing.expires_at and clock() > pairing.expires_at + 60:
                pairing.state, pairing.error = "expired", "The code expired before it was approved. Start pairing again."
                return None
            delay = pairing.interval
            try:
                resp = await client.post(f"{pairing.cloud_url}/api/pair/poll", json={"secret": pairing._secret})
                data = resp.json()
            except Exception as e:
                pairing.error = f"Cloud is not answering ({e}); still waiting."
                await sleep(max(delay, 5))
                continue

            status = data.get("status")
            if resp.status_code == 200 and status == "approved" and data.get("token"):
                pairing.state, pairing.error = "approved", None
                return data["token"]
            if status in ("denied", "expired", "used", "unknown") and resp.status_code in (400, 404, 410):
                pairing.state = "denied" if status == "denied" else "expired" if status == "expired" else "error"
                pairing.error = data.get("error") or f"Pairing ended: {status}."
                return None
            if resp.status_code == 429:
                delay *= 3
            elif resp.status_code >= 500:
                # Cloud could not issue the credentials (on AWS, provisioning failed). Each retry
                # is a real provisioning attempt, so do not hammer it.
                pairing.error = data.get("error") or "Cloud could not finish pairing; retrying."
                delay = max(delay, 15)
            else:
                pairing.error = None
                expires = _parse_time(data.get("expiresAt"))
                if expires:
                    pairing.expires_at = expires
            await sleep(delay)
        return None
    finally:
        if own:
            await client.aclose()


# --- the credentials on disk ------------------------------------------------------------------

def write_private_file(path: str, text: str) -> None:
    """Write `text` byte for byte, readable by this user only.

    Byte for byte: PEM written in text mode on Windows gets every line ending rewritten.
    This user only: the token and the private key must not be readable by other accounts on the
    machine. The mode applies on POSIX; on Windows a file under the user's profile is already
    private to them, and chmod can only toggle read-only there.
    """
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(text.encode("utf-8"))
    try:
        os.chmod(path, 0o600)  # an existing file keeps its old mode through O_CREAT
    except OSError:
        pass


def read_env(env_path: str) -> dict:
    """The KEY=value lines of the .env file (no quoting rules: these values are ours)."""
    values = {}
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as handle:
            for line in handle.read().splitlines():
                if "=" in line and not line.lstrip().startswith("#"):
                    key, value = line.split("=", 1)
                    values[key.strip()] = value
    return values


def set_env(env_path: str, **values: Optional[str]) -> None:
    """Set (or, with None, remove) keys in the .env file, keeping every other line."""
    lines: list[str] = []
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as handle:
            lines = handle.read().splitlines()
    kept = [line for line in lines if line.split("=", 1)[0].strip() not in values]
    kept += [f"{key}={value}" for key, value in values.items() if value is not None]
    write_private_file(env_path, "\n".join(kept) + "\n")


def save_token(env_path: str, token: str) -> None:
    """Set CLOUD_TOKEN in the .env file, keeping every other line."""
    set_env(env_path, CLOUD_TOKEN=token)


# --- this device's identity ---------------------------------------------------------------------
#
# A device is known to Cloud by an id made once and kept beside its pairing (CLOUD_DEVICE_ID in
# .env), not by its name: the name is a label a person can change, and two decks may well share
# one ("My deck"). The id is the MQTT client id and, on AWS, the Thing name, so pairing again
# reattaches this same device (its history, workspace and name) instead of colliding with itself.

_ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"


def new_device_id(name: str) -> str:
    """`My deck` -> `my-deck-7k4m2q`: readable where ids are shown, unique by its suffix.
    Only [a-z0-9-], which suits an MQTT topic segment and an AWS Thing name alike."""
    import re
    import secrets
    slug = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")[:40] or "edge"
    return f"{slug}-{''.join(secrets.choice(_ID_ALPHABET) for _ in range(6))}"


def client_id_of(token: str) -> Optional[str]:
    """The client id inside a Cloud token (base64 JSON, or plain JSON), if it has one."""
    import base64
    import json
    for decode in (lambda t: base64.b64decode(t).decode("utf-8"), lambda t: t):
        try:
            data = json.loads(decode(token))
            if isinstance(data, dict) and data.get("client_id"):
                return str(data["client_id"])
        except Exception:
            continue
    return None


def ensure_device_id(env_path: str, name: str) -> str:
    """This device's id: the one it has, else the one its current pairing already uses (a device
    paired before ids existed keeps its Cloud identity), else a new one. Saved either way."""
    env = read_env(env_path)
    device_id = env.get("CLOUD_DEVICE_ID") or client_id_of(env.get("CLOUD_TOKEN") or "") or new_device_id(name)
    if env.get("CLOUD_DEVICE_ID") != device_id:
        set_env(env_path, CLOUD_DEVICE_ID=device_id)
    return device_id


def remove_aws_certificates(cert_dir: str) -> None:
    for name in ("root-CA.crt", "device.cert.pem", "device.private.key"):
        try:
            os.remove(os.path.join(cert_dir, name))
        except FileNotFoundError:
            pass


def write_aws_certificates(certs: dict, cert_dir: str) -> tuple[str, str, str]:
    """Write an AWS IoT token's certificates; returns (root CA, certificate, private key) paths.

    Refuses an incomplete token up front: written empty, the files fail later as an unexplained
    TLS handshake error instead of saying what is actually wrong.
    """
    missing = [k for k in ("root_ca", "cert_pem", "private_key") if "-----BEGIN" not in str(certs.get(k) or "")]
    if missing:
        raise ValueError(f"The Cloud token is missing its {', '.join(missing)}. Pair this device again.")
    os.makedirs(cert_dir, exist_ok=True)
    try:
        os.chmod(cert_dir, 0o700)
    except OSError:
        pass
    paths = (os.path.join(cert_dir, "root-CA.crt"),
             os.path.join(cert_dir, "device.cert.pem"),
             os.path.join(cert_dir, "device.private.key"))
    for path, key in zip(paths, ("root_ca", "cert_pem", "private_key")):
        write_private_file(path, certs[key])
    return paths
