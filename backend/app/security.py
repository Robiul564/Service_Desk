"""Password hashing, signed expiring access tokens, and short-lived
WebSocket tickets — all implemented with the stdlib only.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from threading import Lock

from .domain import Role
from .errors import AuthError, RateLimitError

_ITERATIONS = 120_000

# ---------------------------------------------------------------------------
# Login rate limiter
# ---------------------------------------------------------------------------
# Simple sliding-window counter keyed by client IP.  After MAX_ATTEMPTS
# failures within the window the endpoint returns 429 for the remainder of
# WINDOW_SECONDS.  Successful logins clear the counter for that IP so normal
# usage is not penalised.
_MAX_ATTEMPTS = 10
_WINDOW_SECONDS = 60

_rate_lock: Lock = Lock()
# {ip: [timestamp, ...]}
_attempts: dict[str, list[float]] = {}


def reset_rate_limiter() -> None:
    """Clear all rate-limit state.  Only used in tests."""
    with _rate_lock:
        _attempts.clear()


def check_login_rate(ip: str) -> None:
    """Raise ``RateLimitError`` (HTTP 429) if the IP has too many recent attempts."""
    now = time.time()
    cutoff = now - _WINDOW_SECONDS
    with _rate_lock:
        history = [t for t in _attempts.get(ip, []) if t > cutoff]
        if len(history) >= _MAX_ATTEMPTS:
            raise RateLimitError(
                f"Too many sign-in attempts. Please wait {_WINDOW_SECONDS} seconds.",
                retry_after=_WINDOW_SECONDS,
            )
        history.append(now)
        _attempts[ip] = history


def clear_login_rate(ip: str) -> None:
    """Reset the counter for an IP after a successful login."""
    with _rate_lock:
        _attempts.pop(ip, None)


@dataclass(frozen=True)
class AuthUser:
    id: int
    username: str
    full_name: str
    role: Role

    @property
    def is_supervisor(self) -> bool:
        return self.role == Role.SUPERVISOR


def hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), _ITERATIONS)
    return f"pbkdf2${_ITERATIONS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, expected = stored.split("$")
        digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations))
    except ValueError:
        return False
    return hmac.compare_digest(digest.hex(), expected)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(body: str, secret: str) -> str:
    return _b64(hmac.new(secret.encode(), body.encode(), hashlib.sha256).digest())


def create_token(user: AuthUser, secret: str, ttl_minutes: int) -> str:
    payload = {
        "sub": user.id,
        "usr": user.username,
        "name": user.full_name,
        "role": user.role.value,
        "exp": int(time.time()) + ttl_minutes * 60,
    }
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    return f"{body}.{_sign(body, secret)}"


def decode_token(token: str, secret: str) -> AuthUser:
    try:
        body, signature = token.split(".")
        if not hmac.compare_digest(signature, _sign(body, secret)):
            raise AuthError("Invalid token")
        payload = json.loads(_unb64(body))
        if payload["exp"] < time.time():
            raise AuthError("Session expired, please sign in again")
        return AuthUser(
            id=payload["sub"],
            username=payload["usr"],
            full_name=payload["name"],
            role=Role(payload["role"]),
        )
    except AuthError:
        raise
    except Exception as exc:  # malformed token of any kind
        raise AuthError("Invalid token") from exc


# ---------------------------------------------------------------------------
# WebSocket one-time tickets
# ---------------------------------------------------------------------------
# The long-lived Bearer token must not appear in server access logs as a bare
# query-string value.  Instead the browser calls POST /api/auth/ws-ticket (over
# an already-authenticated REST session) to get a short-lived, single-use
# ticket.  The WebSocket endpoint exchanges the ticket for the caller's identity
# without ever seeing the long-lived token.
_WS_TICKET_TTL = 30  # seconds — enough to open a socket, not long enough to reuse

_ticket_lock: Lock = Lock()
# {ticket_id: (user_json_str, expires_at)}
_pending_tickets: dict[str, tuple[str, float]] = {}


def _purge_expired_tickets() -> None:
    now = time.time()
    expired = [k for k, (_, exp) in _pending_tickets.items() if exp < now]
    for k in expired:
        del _pending_tickets[k]


def create_ws_ticket(user: AuthUser) -> str:
    """Mint a single-use ticket and return its opaque id."""
    ticket_id = secrets.token_urlsafe(32)
    payload = json.dumps(
        {"sub": user.id, "usr": user.username, "name": user.full_name, "role": user.role.value},
        separators=(",", ":"),
    )
    with _ticket_lock:
        _purge_expired_tickets()
        _pending_tickets[ticket_id] = (payload, time.time() + _WS_TICKET_TTL)
    return ticket_id


def redeem_ws_ticket(ticket_id: str) -> AuthUser:
    """Exchange a ticket for the associated user.  Each ticket can only be used once."""
    with _ticket_lock:
        _purge_expired_tickets()
        entry = _pending_tickets.pop(ticket_id, None)
    if entry is None:
        raise AuthError("Invalid or expired WebSocket ticket")
    payload = json.loads(entry[0])
    return AuthUser(
        id=payload["sub"],
        username=payload["usr"],
        full_name=payload["name"],
        role=Role(payload["role"]),
    )
