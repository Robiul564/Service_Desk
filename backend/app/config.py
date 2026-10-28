"""Application configuration.

Values come from environment variables, optionally pre-loaded from a
``backend/.env`` file. Nothing here talks to the database or the network,
so it is safe to import from anywhere.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent


def _load_dotenv(path: Path) -> None:
    """Tiny .env reader so we don't need an extra dependency."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def _as_bool(value: str) -> bool:
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    database_url: str
    secret_key: str
    token_ttl_minutes: int
    worker_count: int
    step_delay_seconds: float
    ticks_per_step: int
    failure_rate: float
    seed_demo_users: bool
    log_level: str
    cors_origins: tuple[str, ...]
    frontend_dir: Path

    def __post_init__(self) -> None:
        if self.worker_count < 1:
            raise ValueError("WORKER_COUNT must be at least 1")
        if self.ticks_per_step < 1:
            raise ValueError("TICKS_PER_STEP must be at least 1")
        if not 0 <= self.failure_rate <= 1:
            raise ValueError("FAILURE_RATE must be between 0 and 1")


def load_settings() -> Settings:
    _load_dotenv(BACKEND_DIR / ".env")
    data_dir = BACKEND_DIR / "data"
    data_dir.mkdir(exist_ok=True)

    origins = os.getenv("CORS_ORIGINS", "")
    return Settings(
        database_url=os.getenv("DATABASE_URL", f"sqlite:///{data_dir / 'service_requests.db'}"),
        secret_key=os.getenv("SECRET_KEY", "dev-only-secret-change-me"),
        token_ttl_minutes=int(os.getenv("TOKEN_TTL_MINUTES", "480")),
        worker_count=int(os.getenv("WORKER_COUNT", "4")),
        step_delay_seconds=float(os.getenv("STEP_DELAY_SECONDS", "2.0")),
        ticks_per_step=int(os.getenv("TICKS_PER_STEP", "3")),
        failure_rate=float(os.getenv("FAILURE_RATE", "0.08")),
        seed_demo_users=_as_bool(os.getenv("SEED_DEMO_USERS", "true")),
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        cors_origins=tuple(o.strip() for o in origins.split(",") if o.strip()),
        frontend_dir=Path(os.getenv("FRONTEND_DIR", PROJECT_DIR / "frontend")),
    )
