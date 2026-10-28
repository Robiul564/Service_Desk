"""Password hashing and signed, expiring access tokens (stdlib only)."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass

from .domain import Role
from .errors import AuthError

_ITERATIONS = 120_000


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
