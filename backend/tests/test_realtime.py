from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from .conftest import VALID, login


def _token(headers: dict) -> str:
    return headers["Authorization"].split(" ", 1)[1]


def _next_of_type(ws, wanted: str, limit: int = 40) -> dict:
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["type"] == wanted:
            return msg
    raise AssertionError(f"never received {wanted}")


def test_rejects_connection_without_valid_token(client):
    with client.websocket_connect("/ws?token=bad") as ws:
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert info.value.code == 4401


def test_ws_ticket_accepted_instead_of_token(client, alice):
    """A short-lived ticket issued by POST /api/auth/ws-ticket can open the socket."""
    ticket_res = client.post("/api/auth/ws-ticket", headers=alice)
    assert ticket_res.status_code == 200
    ticket = ticket_res.json()["ticket"]

    with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "connection.ready"
        assert msg["data"]["user"] == "alice"


def test_ws_ticket_is_single_use(client, alice):
    """Redeeming a ticket a second time must be rejected."""
    ticket = client.post("/api/auth/ws-ticket", headers=alice).json()["ticket"]
    # First use succeeds.
    with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
        ws.receive_json()  # connection.ready

    # Second use must be rejected.
    with client.websocket_connect(f"/ws?ticket={ticket}") as ws:
        with pytest.raises(WebSocketDisconnect) as info:
            ws.receive_json()
        assert info.value.code == 4401


def test_supervisor_receives_live_events_for_other_users_requests(client, alice, sam):
    with client.websocket_connect(f"/ws?token={_token(sam)}") as ws:
        assert ws.receive_json()["type"] == "connection.ready"
        assert ws.receive_json()["type"] == "stats.updated"

        created = client.post("/api/requests", json=VALID, headers=alice).json()

        msg = _next_of_type(ws, "request.created")
        assert msg["data"]["id"] == created["id"]
        assert msg["data"]["created_by_name"] == "Alice Operator"

        # and progress arrives without anyone asking for it
        progress = _next_of_type(ws, "request.progress")
        assert progress["data"]["id"] == created["id"]
        assert 0 < progress["data"]["progress"] < 100

        done = _next_of_type(ws, "request.updated")
        while done["data"]["status"] != "COMPLETED":
            done = _next_of_type(ws, "request.updated")
        assert done["data"]["progress"] == 100


def test_operator_does_not_receive_other_operators_events(client, alice, bob):
    with client.websocket_connect(f"/ws?token={_token(bob)}") as ws:
        ws.receive_json(); ws.receive_json()

        client.post("/api/requests", json=VALID, headers=alice)  # alice's request
        mine = client.post("/api/requests", json={**VALID, "title": "Bob's own request"}, headers=bob).json()

        first = _next_of_type(ws, "request.created")
        assert first["data"]["id"] == mine["id"], "bob must not see alice's request"


def test_ping_pong(client, alice):
    with client.websocket_connect(f"/ws?token={_token(alice)}") as ws:
        ws.receive_json(); ws.receive_json()
        ws.send_text("ping")
        assert ws.receive_json()["type"] == "pong"


def test_stats_event_follows_status_changes(client, alice):
    with client.websocket_connect(f"/ws?token={_token(alice)}") as ws:
        ws.receive_json(); ws.receive_json()
        rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
        client.post(f"/api/requests/{rid}/cancel", headers=alice)

        for _ in range(40):
            msg = ws.receive_json()
            if msg["type"] == "stats.updated" and msg["data"]["cancelled"] == 1:
                assert msg["data"]["total"] == 1
                return
        raise AssertionError("no stats update reflecting the cancellation")
