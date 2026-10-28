from __future__ import annotations

from fastapi import APIRouter, Request
from sqlalchemy import text
from starlette.concurrency import run_in_threadpool

router = APIRouter(prefix="/api", tags=["system"])


@router.get("/health", summary="Liveness and basic runtime info")
async def health(request: Request) -> dict:
    state = request.app.state

    def ping_db() -> bool:
        with state.engine_db.connect() as conn:
            conn.execute(text("SELECT 1"))
        return True

    try:
        db_ok = await run_in_threadpool(ping_db)
    except Exception:
        db_ok = False
    return {
        "status": "ok" if db_ok else "degraded",
        "database": "up" if db_ok else "down",
        "workers": state.engine.worker_count,
        "queued": state.engine.queue_size,
        "processing": len(state.engine.active),
        "websocket_clients": state.manager.count,
    }
