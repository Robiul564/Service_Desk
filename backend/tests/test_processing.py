from __future__ import annotations

import time

from .conftest import VALID, login, wait_for_status


def test_request_runs_through_to_completed(client, alice):
    rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
    done = wait_for_status(client, alice, rid, "COMPLETED")
    assert done["progress"] == 100
    statuses = [e["to_status"] for e in done["events"]]
    assert statuses == ["PENDING", "IN_PROGRESS", "COMPLETED"]


def test_api_stays_responsive_and_requests_run_concurrently(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from .conftest import make_settings

    # 6 requests x ~0.6s each. One worker would need ~3.6s, three workers ~1.2s.
    settings = make_settings(tmp_path, step_delay_seconds=0.12, worker_count=3, ticks_per_step=1)
    with TestClient(create_app(settings)) as c:
        h = login(c, "alice")
        started = time.time()
        ids = [c.post("/api/requests", json={**VALID, "title": f"Job number {i}"}, headers=h).json()["id"] for i in range(6)]

        # While work is running, the API must still answer quickly.
        t = time.time()
        assert c.get("/api/health").status_code == 200
        assert time.time() - t < 0.5

        peak = 0
        while time.time() - started < 8:
            health = c.get("/api/health").json()
            peak = max(peak, health["processing"])
            if c.get("/api/requests/stats", headers=h).json()["completed"] == 6:
                break
            time.sleep(0.02)
        elapsed = time.time() - started

        assert c.get("/api/requests/stats", headers=h).json()["completed"] == 6
        assert peak >= 2, "expected several requests in progress at the same time"
        assert elapsed < 3.0, f"took {elapsed:.1f}s - looks sequential"
        assert len(set(ids)) == 6


def test_cancel_in_progress_stops_the_worker(slow_client):
    c = slow_client
    h = login(c, "alice")
    rid = c.post("/api/requests", json=VALID, headers=h).json()["id"]
    wait_for_status(c, h, rid, "IN_PROGRESS")
    assert c.post(f"/api/requests/{rid}/cancel", headers=h).status_code == 200

    time.sleep(1.5)  # long enough for a stray worker to overwrite the state
    final = c.get(f"/api/requests/{rid}", headers=h).json()
    assert final["status"] == "CANCELLED"
    assert final["progress"] < 100
    assert [e["to_status"] for e in final["events"]][-1] == "CANCELLED"


def test_failed_request_can_be_retried(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from .conftest import make_settings

    with TestClient(create_app(make_settings(tmp_path, failure_rate=1.0))) as c:
        h = login(c, "alice")
        rid = c.post("/api/requests", json=VALID, headers=h).json()["id"]
        failed = wait_for_status(c, h, rid, "FAILED")
        assert failed["failure_reason"]

        retry = c.post(f"/api/requests/{rid}/retry", headers=h)
        assert retry.status_code == 200
        assert retry.json()["failure_reason"] is None
        wait_for_status(c, h, rid, "FAILED")  # failure_rate=1.0, so it fails again - but it ran

        # Only failed requests can be retried
        other = c.post("/api/requests", json=VALID, headers=h).json()["id"]
        c.post(f"/api/requests/{other}/cancel", headers=h)
        assert c.post(f"/api/requests/{other}/retry", headers=h).status_code == 409


def test_urgent_requests_jump_the_queue(tmp_path):
    from fastapi.testclient import TestClient
    from app.main import create_app
    from .conftest import make_settings

    settings = make_settings(tmp_path, worker_count=1, step_delay_seconds=0.3, ticks_per_step=1)
    with TestClient(create_app(settings)) as c:
        h = login(c, "alice")
        first = c.post("/api/requests", json=VALID, headers=h).json()["id"]
        wait_for_status(c, h, first, "IN_PROGRESS")
        low = c.post("/api/requests", json={**VALID, "priority": "LOW"}, headers=h).json()["id"]
        urgent = c.post("/api/requests", json={**VALID, "priority": "URGENT"}, headers=h).json()["id"]

        urgent_done = wait_for_status(c, h, urgent, "COMPLETED", timeout=15)
        low_now = c.get(f"/api/requests/{low}", headers=h).json()
        assert low_now["status"] != "COMPLETED"  # urgent ran first
        assert urgent_done["status"] == "COMPLETED"
