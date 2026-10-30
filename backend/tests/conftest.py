from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app
from app.security import reset_rate_limiter


def make_settings(tmp_path: Path, **overrides) -> Settings:
    values = dict(
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        secret_key="test-secret",
        token_ttl_minutes=60,
        worker_count=3,
        step_delay_seconds=0.05,
        ticks_per_step=2,
        failure_rate=0.0,
        seed_demo_users=True,
        log_level="WARNING",
        cors_origins=(),
        frontend_dir=tmp_path / "no-frontend",
    )
    values.update(overrides)
    return Settings(**values)


@pytest.fixture(autouse=True)
def _clear_rate_limiter():
    """Reset the login rate-limiter state before every test so that tests
    that deliberately exhaust the limit do not affect subsequent tests."""
    reset_rate_limiter()
    yield


@pytest.fixture()
def client(tmp_path):
    with TestClient(create_app(make_settings(tmp_path))) as c:
        yield c


@pytest.fixture()
def slow_client(tmp_path):
    """Steps are slow enough to cancel a request mid-flight."""
    with TestClient(create_app(make_settings(tmp_path, step_delay_seconds=0.6, worker_count=2))) as c:
        yield c


def login(client: TestClient, username: str) -> dict:
    res = client.post("/api/auth/login", json={"username": username, "password": "Password123!"})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['token']}"}


@pytest.fixture()
def alice(client):
    return login(client, "alice")


@pytest.fixture()
def bob(client):
    return login(client, "bob")


@pytest.fixture()
def sam(client):
    return login(client, "sam")


VALID = {
    "title": "Router replacement",
    "description": "The office router keeps dropping the connection every hour.",
    "category": "REPAIR",
    "priority": "HIGH",
}


def wait_for_status(client, headers, request_id, status, timeout=8.0):
    deadline = time.time() + timeout
    body = None
    while time.time() < deadline:
        body = client.get(f"/api/requests/{request_id}", headers=headers).json()
        if body["status"] == status:
            return body
        time.sleep(0.05)
    raise AssertionError(f"request {request_id} never reached {status}; last: {body}")
