"""Comprehensive test suite for the Service Request Management System.

Covers every functional requirement from the assignment brief:
  - Authentication and session management
  - Rate limiting on login
  - Service request CRUD
  - Input validation (field-level errors)
  - Role-based access control (operator vs supervisor)
  - Request lifecycle: PENDING → IN_PROGRESS → COMPLETED / FAILED / CANCELLED
  - Priority queue ordering
  - Retry after failure
  - Search, filter, sort, pagination
  - Stats endpoint
  - Health endpoint
  - WebSocket: ticket auth, single-use, live events, ping/pong, scoping
  - Concurrent processing (non-blocking API)
  - Crash recovery (interrupted requests re-queued on startup)
  - Security: token tampering, expired token, cross-user isolation
"""
from __future__ import annotations

import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app
from app.security import _MAX_ATTEMPTS

from .conftest import VALID, login, make_settings, wait_for_status


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _token(auth_headers: dict) -> str:
    return auth_headers["Authorization"].split(" ", 1)[1]


def _next_ws_event(ws, event_type: str, limit: int = 50) -> dict:
    """Drain WebSocket messages until the wanted event type arrives."""
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == event_type:
            return msg
    raise AssertionError(f"Never received a '{event_type}' event within {limit} messages")


# ===========================================================================
# 1. Authentication
# ===========================================================================

class TestAuthentication:
    def test_login_returns_token_and_user_info(self, client):
        res = client.post("/api/auth/login", json={"username": "alice", "password": "Password123!"})
        assert res.status_code == 200
        body = res.json()
        assert "token" in body
        assert body["user"]["username"] == "alice"
        assert body["user"]["role"] == "OPERATOR"
        assert body["user"]["full_name"] == "Alice Operator"

    def test_wrong_password_returns_401(self, client):
        res = client.post("/api/auth/login", json={"username": "alice", "password": "wrongpass"})
        assert res.status_code == 401
        assert res.json()["error"]["code"] == "unauthorized"

    def test_unknown_username_returns_401(self, client):
        res = client.post("/api/auth/login", json={"username": "nobody", "password": "Password123!"})
        assert res.status_code == 401

    def test_me_returns_current_user(self, client, alice):
        res = client.get("/api/auth/me", headers=alice)
        assert res.status_code == 200
        assert res.json()["username"] == "alice"

    def test_me_without_token_returns_401(self, client):
        assert client.get("/api/auth/me").status_code == 401

    def test_me_with_garbage_token_returns_401(self, client):
        assert client.get("/api/auth/me", headers={"Authorization": "Bearer garbage"}).status_code == 401

    def test_supervisor_role_is_returned_correctly(self, client, sam):
        res = client.get("/api/auth/me", headers=sam)
        assert res.json()["role"] == "SUPERVISOR"


# ===========================================================================
# 2. Login rate limiting
# ===========================================================================

class TestRateLimiting:
    def test_rate_limit_triggers_after_max_attempts(self, client):
        for _ in range(_MAX_ATTEMPTS):
            client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})
        blocked = client.post("/api/auth/login", json={"username": "alice", "password": "Password123!"})
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "rate_limited"

    def test_rate_limit_response_has_retry_after_header(self, client):
        for _ in range(_MAX_ATTEMPTS):
            client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})
        res = client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})
        assert "Retry-After" in res.headers
        assert int(res.headers["Retry-After"]) > 0

    def test_successful_login_clears_rate_limit_counter(self, client):
        # A few failures followed by a success should clear the counter.
        for _ in range(3):
            client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})
        ok = client.post("/api/auth/login", json={"username": "alice", "password": "Password123!"})
        assert ok.status_code == 200
        # Subsequent attempts should be accepted again (counter was cleared).
        again = client.post("/api/auth/login", json={"username": "alice", "password": "Password123!"})
        assert again.status_code == 200


# ===========================================================================
# 3. Request creation and validation
# ===========================================================================

class TestRequestCreation:
    def test_create_returns_201_with_reference(self, client, alice):
        res = client.post("/api/requests", json=VALID, headers=alice)
        assert res.status_code == 201
        body = res.json()
        assert body["reference"] == f"SR-{body['id']:05d}"
        assert body["status"] in {"PENDING", "IN_PROGRESS"}
        assert body["priority"] == "HIGH"

    def test_create_without_auth_returns_401(self, client):
        assert client.post("/api/requests", json=VALID).status_code == 401

    def test_title_too_short_returns_422(self, client, alice):
        res = client.post("/api/requests", json={**VALID, "title": "ab"}, headers=alice)
        assert res.status_code == 422
        fields = {d["field"] for d in res.json()["error"]["details"]}
        assert "title" in fields

    def test_title_too_long_returns_422(self, client, alice):
        res = client.post("/api/requests", json={**VALID, "title": "x" * 121}, headers=alice)
        assert res.status_code == 422

    def test_description_too_short_returns_422(self, client, alice):
        res = client.post("/api/requests", json={**VALID, "description": "short"}, headers=alice)
        assert res.status_code == 422
        fields = {d["field"] for d in res.json()["error"]["details"]}
        assert "description" in fields

    def test_invalid_category_returns_422(self, client, alice):
        res = client.post("/api/requests", json={**VALID, "category": "INVALID"}, headers=alice)
        assert res.status_code == 422

    def test_invalid_priority_returns_422(self, client, alice):
        res = client.post("/api/requests", json={**VALID, "priority": "SUPER_URGENT"}, headers=alice)
        assert res.status_code == 422

    def test_whitespace_title_fails_length_check(self, client, alice):
        # Titles that are only spaces should fail validation after stripping.
        res = client.post("/api/requests", json={**VALID, "title": "   a   "}, headers=alice)
        assert res.status_code == 422

    def test_default_priority_is_medium(self, client, alice):
        payload = {k: v for k, v in VALID.items() if k != "priority"}
        res = client.post("/api/requests", json=payload, headers=alice)
        assert res.status_code == 201
        assert res.json()["priority"] == "MEDIUM"

    def test_all_categories_are_accepted(self, client, alice):
        for cat in ("INSTALLATION", "MAINTENANCE", "REPAIR", "INQUIRY", "OTHER"):
            res = client.post("/api/requests", json={**VALID, "category": cat}, headers=alice)
            assert res.status_code == 201, f"category {cat} was rejected"

    def test_all_priorities_are_accepted(self, client, alice):
        for prio in ("LOW", "MEDIUM", "HIGH", "URGENT"):
            res = client.post("/api/requests", json={**VALID, "priority": prio}, headers=alice)
            assert res.status_code == 201, f"priority {prio} was rejected"

    def test_multiple_invalid_fields_all_reported(self, client, alice):
        res = client.post(
            "/api/requests",
            json={**VALID, "title": "ab", "category": "NOPE"},
            headers=alice,
        )
        assert res.status_code == 422
        fields = {d["field"] for d in res.json()["error"]["details"]}
        assert {"title", "category"} <= fields


# ===========================================================================
# 4. Role-based access control
# ===========================================================================

class TestRoleBasedAccess:
    def test_operator_sees_only_own_requests(self, client, alice, bob, sam):
        client.post("/api/requests", json=VALID, headers=alice)
        client.post("/api/requests", json={**VALID, "title": "Bob task"}, headers=bob)
        assert client.get("/api/requests", headers=alice).json()["total"] == 1
        assert client.get("/api/requests", headers=bob).json()["total"] == 1

    def test_supervisor_sees_all_requests(self, client, alice, bob, sam):
        client.post("/api/requests", json=VALID, headers=alice)
        client.post("/api/requests", json={**VALID, "title": "Bob task"}, headers=bob)
        assert client.get("/api/requests", headers=sam).json()["total"] == 2

    def test_operator_cannot_read_another_operators_request(self, client, alice, bob):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        assert client.get(f"/api/requests/{rid}", headers=bob).status_code == 404

    def test_operator_cannot_cancel_another_operators_request(self, client, alice, bob):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        assert client.post(f"/api/requests/{rid}/cancel", headers=bob).status_code == 404

    def test_supervisor_can_cancel_any_request(self, client, alice, sam):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        res = client.post(f"/api/requests/{rid}/cancel", headers=sam)
        assert res.status_code == 200
        assert res.json()["status"] == "CANCELLED"

    def test_unknown_request_id_returns_404(self, client, alice):
        assert client.get("/api/requests/99999", headers=alice).status_code == 404


# ===========================================================================
# 5. Listing, search, filter, sort, pagination
# ===========================================================================

class TestListSearchFilterSort:
    def test_list_returns_paginated_results(self, client, alice):
        for i in range(5):
            client.post("/api/requests", json={**VALID, "title": f"Request {i}"}, headers=alice)
        page1 = client.get("/api/requests", params={"page": 1, "page_size": 3}, headers=alice).json()
        assert len(page1["items"]) == 3
        assert page1["total"] == 5
        assert page1["pages"] == 2

    def test_page_2_returns_remaining_items(self, client, alice):
        for i in range(5):
            client.post("/api/requests", json={**VALID, "title": f"Item {i}"}, headers=alice)
        page2 = client.get("/api/requests", params={"page": 2, "page_size": 3}, headers=alice).json()
        assert len(page2["items"]) == 2

    def test_page_size_above_100_returns_422(self, client, alice):
        assert client.get("/api/requests", params={"page_size": 101}, headers=alice).status_code == 422

    def test_text_search_by_title(self, client, alice):
        client.post("/api/requests", json={**VALID, "title": "Install fibre line"}, headers=alice)
        client.post("/api/requests", json={**VALID, "title": "Broken printer repair"}, headers=alice)
        res = client.get("/api/requests", params={"q": "fibre"}, headers=alice).json()
        assert res["total"] == 1
        assert res["items"][0]["title"] == "Install fibre line"

    def test_text_search_is_case_insensitive(self, client, alice):
        client.post("/api/requests", json={**VALID, "title": "Router Replacement"}, headers=alice)
        res = client.get("/api/requests", params={"q": "router"}, headers=alice).json()
        assert res["total"] == 1

    def test_percent_wildcard_is_treated_literally(self, client, alice):
        client.post("/api/requests", json=VALID, headers=alice)
        res = client.get("/api/requests", params={"q": "%"}, headers=alice).json()
        assert res["total"] == 0

    def test_underscore_wildcard_is_treated_literally(self, client, alice):
        client.post("/api/requests", json=VALID, headers=alice)
        res = client.get("/api/requests", params={"q": "_"}, headers=alice).json()
        assert res["total"] == 0

    def test_filter_by_category(self, client, alice):
        client.post("/api/requests", json={**VALID, "category": "REPAIR"}, headers=alice)
        client.post("/api/requests", json={**VALID, "category": "INQUIRY"}, headers=alice)
        res = client.get("/api/requests", params={"category": "REPAIR"}, headers=alice).json()
        assert res["total"] == 1
        assert res["items"][0]["category"] == "REPAIR"

    def test_filter_by_priority(self, client, alice):
        client.post("/api/requests", json={**VALID, "priority": "URGENT"}, headers=alice)
        client.post("/api/requests", json={**VALID, "priority": "LOW"}, headers=alice)
        res = client.get("/api/requests", params={"priority": "URGENT"}, headers=alice).json()
        assert res["total"] == 1

    def test_sort_by_priority_puts_urgent_first(self, client, alice):
        client.post("/api/requests", json={**VALID, "priority": "LOW"}, headers=alice)
        client.post("/api/requests", json={**VALID, "priority": "URGENT"}, headers=alice)
        client.post("/api/requests", json={**VALID, "priority": "MEDIUM"}, headers=alice)
        res = client.get("/api/requests", params={"sort": "priority"}, headers=alice).json()
        assert res["items"][0]["priority"] == "URGENT"

    def test_sort_oldest_returns_first_submitted_first(self, client, alice):
        ids = [
            client.post("/api/requests", json={**VALID, "title": f"Task {i}"}, headers=alice).json()["id"]
            for i in range(3)
        ]
        res = client.get("/api/requests", params={"sort": "oldest"}, headers=alice).json()
        assert res["items"][0]["id"] == ids[0]


# ===========================================================================
# 6. Request detail and edit
# ===========================================================================

class TestRequestDetail:
    def test_get_detail_includes_events(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        detail = client.get(f"/api/requests/{rid}", headers=alice).json()
        assert "events" in detail
        assert len(detail["events"]) >= 1
        assert detail["events"][0]["to_status"] == "PENDING"

    def test_edit_pending_request(self, slow_client):
        c = slow_client
        h = login(c, "alice")
        # Fill workers to keep 3rd request PENDING.
        c.post("/api/requests", json=VALID, headers=h)
        c.post("/api/requests", json=VALID, headers=h)
        rid = c.post("/api/requests", json=VALID, headers=h).json()["id"]
        res = c.patch(f"/api/requests/{rid}", json={"title": "Updated title"}, headers=h)
        assert res.status_code == 200
        assert res.json()["title"] == "Updated title"

    def test_edit_requires_at_least_one_field(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        res = client.patch(f"/api/requests/{rid}", json={}, headers=alice)
        assert res.status_code == 422

    def test_cannot_edit_completed_request(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        wait_for_status(client, alice, rid, "COMPLETED")
        res = client.patch(f"/api/requests/{rid}", json={"title": "New title"}, headers=alice)
        assert res.status_code == 409

    def test_request_has_sr_reference_format(self, client, alice):
        body = client.post("/api/requests", json=VALID, headers=alice).json()
        assert body["reference"].startswith("SR-")
        assert body["reference"] == f"SR-{body['id']:05d}"


# ===========================================================================
# 7. Stats endpoint
# ===========================================================================

class TestStats:
    def test_stats_counts_are_accurate(self, client, alice):
        client.post("/api/requests", json=VALID, headers=alice)
        stats = client.get("/api/requests/stats", headers=alice).json()
        assert stats["total"] >= 1

    def test_cancelled_request_is_reflected_in_stats(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        client.post(f"/api/requests/{rid}/cancel", headers=alice)
        stats = client.get("/api/requests/stats", headers=alice).json()
        assert stats["cancelled"] >= 1

    def test_supervisor_stats_cover_all_users(self, client, alice, bob, sam):
        client.post("/api/requests", json=VALID, headers=alice)
        client.post("/api/requests", json={**VALID, "title": "Bob task"}, headers=bob)
        stats = client.get("/api/requests/stats", headers=sam).json()
        assert stats["total"] >= 2

    def test_operator_stats_only_count_own_requests(self, client, alice, bob):
        client.post("/api/requests", json=VALID, headers=alice)
        client.post("/api/requests", json={**VALID, "title": "Bob task"}, headers=bob)
        stats = client.get("/api/requests/stats", headers=alice).json()
        assert stats["total"] == 1

    def test_avg_completion_seconds_is_present_after_completion(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        wait_for_status(client, alice, rid, "COMPLETED")
        stats = client.get("/api/requests/stats", headers=alice).json()
        assert stats["avg_completion_seconds"] is not None
        assert stats["avg_completion_seconds"] > 0


# ===========================================================================
# 8. Request lifecycle: cancel and retry
# ===========================================================================

class TestLifecycle:
    def test_cancel_pending_request(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        # Cancel immediately — it might still be PENDING.
        res = client.post(f"/api/requests/{rid}/cancel", headers=alice)
        # Either it cancels (200) or it was already picked up by a worker (409 if already COMPLETED).
        assert res.status_code in {200, 409}
        if res.status_code == 200:
            assert res.json()["status"] == "CANCELLED"

    def test_cancel_same_request_twice_returns_409(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        client.post(f"/api/requests/{rid}/cancel", headers=alice)
        again = client.post(f"/api/requests/{rid}/cancel", headers=alice)
        assert again.status_code == 409
        assert again.json()["error"]["code"] == "conflict"

    def test_cancel_in_progress_stops_worker(self, slow_client):
        c = slow_client
        h = login(c, "alice")
        rid = c.post("/api/requests", json=VALID, headers=h).json()["id"]
        wait_for_status(c, h, rid, "IN_PROGRESS")
        assert c.post(f"/api/requests/{rid}/cancel", headers=h).status_code == 200
        time.sleep(1.5)
        final = c.get(f"/api/requests/{rid}", headers=h).json()
        assert final["status"] == "CANCELLED"
        assert final["progress"] < 100

    def test_completed_request_cannot_be_cancelled(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        wait_for_status(client, alice, rid, "COMPLETED")
        res = client.post(f"/api/requests/{rid}/cancel", headers=alice)
        assert res.status_code == 409

    def test_failed_request_can_be_retried(self, tmp_path):
        with TestClient(create_app(make_settings(tmp_path, failure_rate=1.0))) as c:
            h = login(c, "alice")
            rid = c.post("/api/requests", json=VALID, headers=h).json()["id"]
            wait_for_status(c, h, rid, "FAILED")
            retry = c.post(f"/api/requests/{rid}/retry", headers=h)
            assert retry.status_code == 200
            assert retry.json()["status"] == "PENDING"
            assert retry.json()["failure_reason"] is None

    def test_retry_resets_progress_to_zero(self, tmp_path):
        with TestClient(create_app(make_settings(tmp_path, failure_rate=1.0))) as c:
            h = login(c, "alice")
            rid = c.post("/api/requests", json=VALID, headers=h).json()["id"]
            wait_for_status(c, h, rid, "FAILED")
            body = c.post(f"/api/requests/{rid}/retry", headers=h).json()
            assert body["progress"] == 0

    def test_cannot_retry_cancelled_request(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        client.post(f"/api/requests/{rid}/cancel", headers=alice)
        res = client.post(f"/api/requests/{rid}/retry", headers=alice)
        assert res.status_code == 409

    def test_full_lifecycle_events_are_recorded(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        wait_for_status(client, alice, rid, "COMPLETED")
        events = client.get(f"/api/requests/{rid}", headers=alice).json()["events"]
        statuses = [e["to_status"] for e in events]
        assert statuses == ["PENDING", "IN_PROGRESS", "COMPLETED"]

    def test_cancelled_request_has_event_message(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        client.post(f"/api/requests/{rid}/cancel", headers=alice)
        events = client.get(f"/api/requests/{rid}", headers=alice).json()["events"]
        cancel_event = next(e for e in events if e["to_status"] == "CANCELLED")
        assert "alice" in cancel_event["message"].lower() or "cancelled" in cancel_event["message"].lower()


# ===========================================================================
# 9. Concurrent processing and priority queue
# ===========================================================================

class TestConcurrency:
    def test_requests_are_processed_to_completion(self, client, alice):
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        done = wait_for_status(client, alice, rid, "COMPLETED")
        assert done["progress"] == 100
        assert done["current_step"] == "Done"
        assert done["started_at"] is not None
        assert done["completed_at"] is not None

    def test_api_stays_responsive_while_processing(self, tmp_path):
        settings = make_settings(tmp_path, step_delay_seconds=0.12, worker_count=3, ticks_per_step=1)
        with TestClient(create_app(settings)) as c:
            h = login(c, "alice")
            ids = [
                c.post("/api/requests", json={**VALID, "title": f"Job {i}"}, headers=h).json()["id"]
                for i in range(6)
            ]
            # While workers are busy the health endpoint must answer quickly.
            t0 = time.time()
            assert c.get("/api/health").status_code == 200
            assert time.time() - t0 < 0.5, "API became unresponsive while processing"

            # Wait for all to complete.
            deadline = time.time() + 8
            while time.time() < deadline:
                if c.get("/api/requests/stats", headers=h).json()["completed"] == 6:
                    break
                time.sleep(0.05)
            assert c.get("/api/requests/stats", headers=h).json()["completed"] == 6

    def test_parallel_execution_is_faster_than_sequential(self, tmp_path):
        settings = make_settings(tmp_path, step_delay_seconds=0.12, worker_count=3, ticks_per_step=1)
        with TestClient(create_app(settings)) as c:
            h = login(c, "alice")
            start = time.time()
            for i in range(6):
                c.post("/api/requests", json={**VALID, "title": f"Job {i}"}, headers=h)
            deadline = time.time() + 8
            while time.time() < deadline:
                if c.get("/api/requests/stats", headers=h).json()["completed"] == 6:
                    break
                time.sleep(0.02)
            elapsed = time.time() - start
            # Sequential would take ~3.6 s; parallel should finish well under 3 s.
            assert elapsed < 3.0, f"Took {elapsed:.1f}s — looks sequential"

    def test_urgent_requests_jump_the_queue(self, tmp_path):
        settings = make_settings(tmp_path, worker_count=1, step_delay_seconds=0.3, ticks_per_step=1)
        with TestClient(create_app(settings)) as c:
            h = login(c, "alice")
            first = c.post("/api/requests", json=VALID, headers=h).json()["id"]
            wait_for_status(c, h, first, "IN_PROGRESS")

            low = c.post("/api/requests", json={**VALID, "priority": "LOW"}, headers=h).json()["id"]
            urgent = c.post("/api/requests", json={**VALID, "priority": "URGENT"}, headers=h).json()["id"]

            wait_for_status(c, h, urgent, "COMPLETED", timeout=15)
            low_now = c.get(f"/api/requests/{low}", headers=h).json()
            assert low_now["status"] != "COMPLETED", "LOW priority request should not have completed before URGENT"

    def test_multiple_workers_shown_in_health(self, client):
        body = client.get("/api/health").json()
        assert body["status"] == "ok"
        assert body["workers"] == 3
        assert body["database"] == "up"


# ===========================================================================
# 10. Crash recovery
# ===========================================================================

class TestCrashRecovery:
    def test_interrupted_requests_are_requeued_on_restart(self, tmp_path):
        """Simulate a server restart while requests are processing."""
        settings = make_settings(tmp_path, step_delay_seconds=0.5, worker_count=1, ticks_per_step=1)

        rid = None
        # First server instance — submit a request and wait for it to start.
        with TestClient(create_app(settings)) as c:
            h = login(c, "alice")
            rid = c.post("/api/requests", json=VALID, headers=h).json()["id"]
            wait_for_status(c, h, rid, "IN_PROGRESS")
        # Server is now "dead"; the request is stuck IN_PROGRESS in the DB.

        # Second server instance — should pick it back up.
        with TestClient(create_app(settings)) as c:
            h = login(c, "alice")
            # After recovery it goes back to PENDING and then gets re-processed.
            final = wait_for_status(c, h, rid, "COMPLETED", timeout=15)
            assert final["status"] == "COMPLETED"
            # The recovery event should be in the history.
            detail = c.get(f"/api/requests/{rid}", headers=h).json()
            messages = [e["message"] for e in detail["events"]]
            assert any("restart" in m.lower() for m in messages)


# ===========================================================================
# 11. WebSocket: authentication and ticket
# ===========================================================================

class TestWebSocketAuth:
    def test_invalid_token_closes_with_4401(self, client):
        with client.websocket_connect("/ws?token=bad") as ws:
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()
            assert exc_info.value.code == 4401

    def test_no_credentials_closes_with_4401(self, client):
        with client.websocket_connect("/ws") as ws:
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()
            assert exc_info.value.code == 4401

    def test_ws_ticket_endpoint_requires_auth(self, client):
        assert client.post("/api/auth/ws-ticket").status_code == 401

    def test_ws_ticket_is_accepted(self, client, alice):
        ticket = client.post("/api/auth/ws-ticket", headers=alice).json()["ticket"]
        with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "connection.ready"
            assert msg["data"]["user"] == "alice"

    def test_ws_ticket_is_single_use(self, client, alice):
        ticket = client.post("/api/auth/ws-ticket", headers=alice).json()["ticket"]
        # First use succeeds.
        with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
            ws.receive_json()

        # Second use must be rejected.
        with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
            with pytest.raises(WebSocketDisconnect) as exc_info:
                ws.receive_json()
            assert exc_info.value.code == 4401

    def test_legacy_token_still_works(self, client, alice):
        token = _token(alice)
        with client.websocket_connect(f"/ws?token={token}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "connection.ready"


# ===========================================================================
# 12. WebSocket: live events and scoping
# ===========================================================================

class TestWebSocketEvents:
    def test_connection_ready_event_is_first(self, client, alice):
        with client.websocket_connect(f"/ws?token={_token(alice)}") as ws:
            msg = ws.receive_json()
            assert msg["type"] == "connection.ready"
            assert "ts" in msg

    def test_stats_event_is_sent_on_connect(self, client, alice):
        with client.websocket_connect(f"/ws?token={_token(alice)}") as ws:
            ws.receive_json()  # connection.ready
            msg = ws.receive_json()
            assert msg["type"] == "stats.updated"
            assert "total" in msg["data"]

    def test_ping_pong(self, client, alice):
        with client.websocket_connect(f"/ws?token={_token(alice)}") as ws:
            ws.receive_json()  # connection.ready
            ws.receive_json()  # stats.updated
            ws.send_text("ping")
            assert ws.receive_json()["type"] == "pong"

    def test_supervisor_receives_any_users_events(self, client, alice, sam):
        with client.websocket_connect(f"/ws?token={_token(sam)}") as ws:
            ws.receive_json()  # connection.ready
            ws.receive_json()  # stats.updated

            created = client.post("/api/requests", json=VALID, headers=alice).json()

            created_event = _next_ws_event(ws, "request.created")
            assert created_event["data"]["id"] == created["id"]

    def test_operator_does_not_see_other_operators_events(self, client, alice, bob):
        with client.websocket_connect(f"/ws?token={_token(bob)}") as ws:
            ws.receive_json()  # connection.ready
            ws.receive_json()  # stats.updated

            # Alice submits a request.
            client.post("/api/requests", json=VALID, headers=alice)
            # Bob submits his own request.
            bob_req = client.post("/api/requests", json={**VALID, "title": "Bob only"}, headers=bob).json()

            first = _next_ws_event(ws, "request.created")
            assert first["data"]["id"] == bob_req["id"], "Bob received Alice's event — scoping is broken"

    def test_stats_event_follows_cancellation(self, client, alice):
        with client.websocket_connect(f"/ws?token={_token(alice)}") as ws:
            ws.receive_json()  # connection.ready
            ws.receive_json()  # stats.updated

            rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
            client.post(f"/api/requests/{rid}/cancel", headers=alice)

            for _ in range(50):
                msg = ws.receive_json()
                if msg["type"] == "stats.updated" and msg["data"]["cancelled"] >= 1:
                    return
            raise AssertionError("No stats.updated reflecting the cancellation arrived")

    def test_progress_events_arrive_during_processing(self, client, sam):
        with client.websocket_connect(f"/ws?token={_token(sam)}") as ws:
            ws.receive_json()  # connection.ready
            ws.receive_json()  # stats.updated

            h = login(client, "alice")
            created = client.post("/api/requests", json=VALID, headers=h).json()

            progress = _next_ws_event(ws, "request.progress")
            assert progress["data"]["id"] == created["id"]
            assert 0 < progress["data"]["progress"] < 100

    def test_completion_event_has_100_percent_progress(self, client, sam):
        with client.websocket_connect(f"/ws?token={_token(sam)}") as ws:
            ws.receive_json()
            ws.receive_json()

            h = login(client, "alice")
            created = client.post("/api/requests", json=VALID, headers=h).json()

            for _ in range(80):
                msg = ws.receive_json()
                if msg["type"] == "request.updated" and msg["data"]["status"] == "COMPLETED":
                    assert msg["data"]["progress"] == 100
                    return
            raise AssertionError("COMPLETED event never arrived")


# ===========================================================================
# 13. Security: token integrity
# ===========================================================================

class TestTokenSecurity:
    def test_tampered_signature_is_rejected(self):
        from app.domain import Role
        from app.errors import AuthError
        from app.security import AuthUser, create_token, decode_token

        user = AuthUser(1, "alice", "Alice Operator", Role.OPERATOR)
        token = create_token(user, "my-secret", ttl_minutes=60)
        tampered = token[:-4] + "xxxx"
        with pytest.raises(AuthError):
            decode_token(tampered, "my-secret")

    def test_wrong_secret_is_rejected(self):
        from app.domain import Role
        from app.errors import AuthError
        from app.security import AuthUser, create_token, decode_token

        user = AuthUser(1, "alice", "Alice Operator", Role.OPERATOR)
        token = create_token(user, "correct-secret", ttl_minutes=60)
        with pytest.raises(AuthError):
            decode_token(token, "wrong-secret")

    def test_expired_token_is_rejected(self):
        from app.domain import Role
        from app.errors import AuthError
        from app.security import AuthUser, create_token, decode_token

        user = AuthUser(1, "alice", "Alice Operator", Role.OPERATOR)
        expired_token = create_token(user, "secret", ttl_minutes=-1)
        with pytest.raises(AuthError):
            decode_token(expired_token, "secret")

    def test_malformed_token_is_rejected(self):
        from app.errors import AuthError
        from app.security import decode_token

        with pytest.raises(AuthError):
            decode_token("not.a.real.token", "secret")

    def test_valid_token_roundtrip(self):
        from app.domain import Role
        from app.security import AuthUser, create_token, decode_token

        user = AuthUser(42, "sam", "Sam Supervisor", Role.SUPERVISOR)
        token = create_token(user, "s3cr3t", ttl_minutes=60)
        decoded = decode_token(token, "s3cr3t")
        assert decoded == user

