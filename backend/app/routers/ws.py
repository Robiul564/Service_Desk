from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..errors import AuthError
from ..security import decode_token

logger = logging.getLogger(__name__)
router = APIRouter()

CLOSE_UNAUTHORIZED = 4401


@router.websocket("/ws")
async def websocket_endpoint(ws: WebSocket, token: str = Query(default="")) -> None:
    state = ws.app.state
    try:
        user = decode_token(token, state.settings.secret_key)
    except AuthError:
        await ws.accept()
        await ws.close(code=CLOSE_UNAUTHORIZED)
        return

    manager = state.manager
    await manager.connect(ws, user)
    await manager.send(ws, "connection.ready", {"user": user.username, "role": user.role.value})
    # Give the new client its counters straight away instead of waiting for a change.
    scope = None if user.is_supervisor else user.id
    stats = await asyncio.to_thread(state.service.stats, scope)
    await manager.send(ws, "stats.updated", stats.model_dump(mode="json"))

    try:
        while True:
            message = await ws.receive_text()
            if message == "ping":  # keep-alive from the browser
                await manager.send(ws, "pong", None)
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(ws)
