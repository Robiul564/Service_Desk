"""WebSocket connection registry and the publisher that turns state changes
into pushed events.

Event envelope sent to clients::

    {"type": "request.updated", "data": {...}, "ts": "2026-01-01T12:00:00+00:00"}
"""
from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import WebSocket

from .schemas import RequestOut
from .security import AuthUser
from .services import RequestService

logger = logging.getLogger(__name__)


@dataclass
class _Client:
    user: AuthUser
    # Starlette sockets are not safe for two coroutines sending at once.
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    @property
    def scope(self) -> int | None:
        """None = sees everything (supervisor), otherwise the operator's own id."""
        return None if self.user.is_supervisor else self.user.id


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: dict[WebSocket, _Client] = {}

    @property
    def count(self) -> int:
        return len(self._clients)

    async def connect(self, ws: WebSocket, user: AuthUser) -> None:
        await ws.accept()
        self._clients[ws] = _Client(user)
        logger.info("WebSocket connected: %s (%d online)", user.username, self.count)

    def disconnect(self, ws: WebSocket) -> None:
        client = self._clients.pop(ws, None)
        if client:
            logger.info("WebSocket disconnected: %s (%d online)", client.user.username, self.count)

    def scopes(self) -> set[int | None]:
        return {c.scope for c in self._clients.values()}

    async def _send(self, ws: WebSocket, client: _Client, message: str) -> None:
        try:
            async with client.lock:
                await asyncio.wait_for(ws.send_text(message), timeout=5)
        except Exception:
            # Dead or too-slow socket: drop it, the client will reconnect.
            self.disconnect(ws)

    @staticmethod
    def _envelope(event: str, data: Any) -> str:
        return json.dumps({"type": event, "data": data, "ts": datetime.now(timezone.utc).isoformat()})

    async def send(self, ws: WebSocket, event: str, data: Any) -> None:
        client = self._clients.get(ws)
        if client:
            await self._send(ws, client, self._envelope(event, data))

    async def broadcast_for_owner(self, event: str, data: Any, owner_id: int) -> None:
        """Supervisors always receive it; operators only if they own the request."""
        message = self._envelope(event, data)
        targets = [
            (ws, c) for ws, c in list(self._clients.items()) if c.scope is None or c.scope == owner_id
        ]
        await asyncio.gather(*(self._send(ws, c, message) for ws, c in targets))

    async def send_to_scope(self, scope: int | None, event: str, data: Any) -> None:
        message = self._envelope(event, data)
        targets = [(ws, c) for ws, c in list(self._clients.items()) if c.scope == scope]
        await asyncio.gather(*(self._send(ws, c, message) for ws, c in targets))


class EventPublisher:
    """What the rest of the app calls when something changed."""

    def __init__(self, manager: ConnectionManager, service: RequestService) -> None:
        self._manager = manager
        self._service = service
        self._stats_running = False
        self._stats_dirty = False

    async def request_created(self, req: RequestOut) -> None:
        await self._manager.broadcast_for_owner("request.created", req.model_dump(mode="json"), req.created_by)
        await self.push_stats()

    async def request_updated(self, req: RequestOut) -> None:
        await self._manager.broadcast_for_owner("request.updated", req.model_dump(mode="json"), req.created_by)
        await self.push_stats()

    async def request_progress(self, req: RequestOut) -> None:
        # Progress ticks don't change any counters, so no stats recalculation.
        await self._manager.broadcast_for_owner("request.progress", req.model_dump(mode="json"), req.created_by)

    async def push_stats(self) -> None:
        """Recompute dashboard counters for every audience that is connected.

        If a burst of changes arrives while a recalculation is running we just
        flag it dirty and loop once more, rather than queueing one per change.
        """
        if self._stats_running:
            self._stats_dirty = True
            return
        self._stats_running = True
        try:
            while True:
                self._stats_dirty = False
                for scope in self._manager.scopes():
                    stats = await asyncio.to_thread(self._service.stats, scope)
                    await self._manager.send_to_scope(scope, "stats.updated", stats.model_dump(mode="json"))
                if not self._stats_dirty:
                    break
        finally:
            self._stats_running = False
