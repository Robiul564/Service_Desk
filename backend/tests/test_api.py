from __future__ import annotations

from .conftest import VALID, login


def test_login_success_and_failure(client):
    ok = client.post("/api/auth/login", json={"username": "alice", "password": "Password123!"})
    assert ok.status_code == 200
    assert ok.json()["user"]["role"] == "OPERATOR"

    bad = client.post("/api/auth/login", json={"username": "alice", "password": "nope"})
    assert bad.status_code == 401
    assert bad.json()["error"]["code"] == "unauthorized"


def test_login_rate_limit(client):
    """After too many failed attempts the endpoint returns 429 with Retry-After."""
    from app.security import _MAX_ATTEMPTS

    for _ in range(_MAX_ATTEMPTS):
        client.post("/api/auth/login", json={"username": "alice", "password": "wrong"})

    blocked = client.post("/api/auth/login", json={"username": "alice", "password": "Password123!"})
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "rate_limited"
    assert "Retry-After" in blocked.headers


def test_endpoints_require_authentication(client):
    assert client.get("/api/requests").status_code == 401
    assert client.get("/api/requests", headers={"Authorization": "Bearer garbage"}).status_code == 401


def test_create_request_returns_reference_and_pending_status(client, alice):
    res = client.post("/api/requests", json=VALID, headers=alice)
    assert res.status_code == 201
    body = res.json()
    assert body["reference"] == f"SR-{body['id']:05d}"
    assert body["status"] in {"PENDING", "IN_PROGRESS"}  # a worker may already have grabbed it
    assert body["created_by_name"] == "Alice Operator"


def test_validation_errors_are_field_level(client, alice):
    res = client.post("/api/requests", json={**VALID, "title": "ab", "category": "NOPE"}, headers=alice)
    assert res.status_code == 422
    fields = {d["field"] for d in res.json()["error"]["details"]}
    assert {"title", "category"} <= fields


def test_whitespace_is_trimmed_before_length_check(client, alice):
    res = client.post("/api/requests", json={**VALID, "title": "   a   "}, headers=alice)
    assert res.status_code == 422


def test_operator_only_sees_own_requests_supervisor_sees_all(client, alice, bob, sam):
    client.post("/api/requests", json=VALID, headers=alice)
    client.post("/api/requests", json={**VALID, "title": "Bob's request"}, headers=bob)

    assert client.get("/api/requests", headers=alice).json()["total"] == 1
    assert client.get("/api/requests", headers=bob).json()["total"] == 1
    assert client.get("/api/requests", headers=sam).json()["total"] == 2


def test_operator_cannot_read_someone_elses_request(client, alice, bob):
    rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
    assert client.get(f"/api/requests/{rid}", headers=bob).status_code == 404
    assert client.post(f"/api/requests/{rid}/cancel", headers=bob).status_code == 404


def test_search_and_filters(client, alice):
    client.post("/api/requests", json={**VALID, "title": "Install fibre line", "category": "INSTALLATION", "priority": "LOW"}, headers=alice)
    client.post("/api/requests", json={**VALID, "title": "Broken printer", "category": "REPAIR", "priority": "URGENT"}, headers=alice)

    by_text = client.get("/api/requests", params={"q": "printer"}, headers=alice).json()
    assert [r["title"] for r in by_text["items"]] == ["Broken printer"]

    by_cat = client.get("/api/requests", params={"category": "INSTALLATION"}, headers=alice).json()
    assert by_cat["total"] == 1

    by_prio = client.get("/api/requests", params={"sort": "priority"}, headers=alice).json()
    assert by_prio["items"][0]["priority"] == "URGENT"

    # % and _ are treated literally, not as wildcards
    assert client.get("/api/requests", params={"q": "%"}, headers=alice).json()["total"] == 0


def test_pagination(client, alice):
    for i in range(5):
        client.post("/api/requests", json={**VALID, "title": f"Request number {i}"}, headers=alice)
    page = client.get("/api/requests", params={"page_size": 2, "page": 3}, headers=alice).json()
    assert page["total"] == 5 and page["pages"] == 3 and len(page["items"]) == 1
    assert client.get("/api/requests", params={"page_size": 500}, headers=alice).status_code == 422


def test_edit_pending_request_only(slow_client):
    c = slow_client
    h = login(c, "alice")
    # Fill both workers so the third request stays pending.
    c.post("/api/requests", json=VALID, headers=h)
    c.post("/api/requests", json=VALID, headers=h)
    third = c.post("/api/requests", json=VALID, headers=h).json()["id"]
    ok = c.patch(f"/api/requests/{third}", json={"title": "Updated title"}, headers=h)
    assert ok.status_code == 200 and ok.json()["title"] == "Updated title"
    assert c.patch(f"/api/requests/{third}", json={}, headers=h).status_code == 422


def test_cancel_twice_conflicts(client, alice):
    rid = client.post("/api/requests", json=VALID, headers=alice).json()["id"]
    assert client.post(f"/api/requests/{rid}/cancel", headers=alice).status_code == 200
    again = client.post(f"/api/requests/{rid}/cancel", headers=alice)
    assert again.status_code == 409
    assert again.json()["error"]["code"] == "conflict"


def test_unknown_request_is_404(client, alice):
    assert client.get("/api/requests/9999", headers=alice).status_code == 404


def test_health_endpoint(client):
    body = client.get("/api/health").json()
    assert body["status"] == "ok" and body["workers"] == 3


def test_token_roundtrip_and_tampering():
    from app.domain import Role
    from app.errors import AuthError
    from app.security import AuthUser, create_token, decode_token
    import pytest

    user = AuthUser(1, "x", "X Y", Role.OPERATOR)
    token = create_token(user, "secret", 5)
    assert decode_token(token, "secret") == user
    with pytest.raises(AuthError):
        decode_token(token, "other-secret")
    with pytest.raises(AuthError):
        decode_token(token[:-2] + "xx", "secret")
    with pytest.raises(AuthError):
        decode_token(create_token(user, "secret", -1), "secret")
