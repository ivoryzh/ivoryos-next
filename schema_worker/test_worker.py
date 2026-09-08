"""Integration test for the /extract endpoint. Requires a running Docker daemon and the sandbox
image built (`docker build -t ivoryos-schema-worker .` from this directory) — this is no longer
a pure-Python unit test since extraction now genuinely launches a container per request.
"""
import json
import shutil
import subprocess

import pytest
from fastapi.testclient import TestClient

from main import app, SANDBOX_IMAGE

client = TestClient(app)


def _docker_ready() -> bool:
    if not shutil.which("docker"):
        return False
    try:
        subprocess.run(["docker", "info"], capture_output=True, timeout=5, check=True)
        subprocess.run(["docker", "image", "inspect", SANDBOX_IMAGE], capture_output=True, timeout=5, check=True)
        return True
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return False


pytestmark = pytest.mark.skipif(
    not _docker_ready(),
    reason=f"Docker daemon not reachable or '{SANDBOX_IMAGE}' not built — run `docker build -t {SANDBOX_IMAGE} .` first",
)


def test_extract_installs_and_inspects_real_package():
    response = client.post("/extract", json={
        "install_url": "requests",
        "module_name": "requests.sessions",
        "class_name": "Session",
    })
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["module"] == "requests.sessions"
    assert "Session" in data["schemas"]


def test_extract_reports_a_clean_error_for_a_bad_package_name():
    response = client.post("/extract", json={
        "install_url": "this-package-definitely-does-not-exist-xyz",
        "module_name": "whatever",
    })
    assert response.status_code == 400
    assert "detail" in response.json()


if __name__ == "__main__":
    if not _docker_ready():
        print(f"Skipping: Docker not reachable or image '{SANDBOX_IMAGE}' not built.")
    else:
        r = client.post("/extract", json={
            "install_url": "requests",
            "module_name": "requests.sessions",
            "class_name": "Session",
        })
        print(f"Status Code: {r.status_code}")
        print(json.dumps(r.json(), indent=2))
