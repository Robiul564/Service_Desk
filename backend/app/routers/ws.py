from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from ..errors import AuthError
from ..security import decode_token, redeem_ws_ticket

logger = logging.getLogger(__name__)
router = APIRouter()

CLOSE_UNAUTHORIZED = 4401


@router.websocket("/ws")
async def websocket_endpoint(
    ws: WebSocket,
    ticket: str = Query(default=""),
    token: str = Query(default=""),
) -> None:
    """Open a live push connection.

    Preferred: obtain a short-lived ticket from ``POST /api/auth/ws-ticket``
    and pass it as ``?ticket=<value>``.  The ticket is single-use and expires
    in 30 seconds, so it never becomes a useful secret even if it appears in
    an access log.

    Legacy fallback: pass ``?token=<bearer>`` directly.  This still works but
    the full Bearer token will appear in access logs, which is undesirable in
    production environments.
    """
    state = ws.app.state
    try:
        if ticket:
            user = redeem_ws_ticket(ticket)
        elif token:
            user = decode_token(token, state.settings.secret_key)
        else:
            raise AuthError("No credentials provided")
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
