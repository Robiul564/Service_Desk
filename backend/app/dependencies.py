"""FastAPI dependencies: pull shared objects off ``app.state`` and authenticate callers."""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .errors import AuthError
from .processing import ProcessingEngine
from .realtime import ConnectionManager, EventPublisher
from .security import AuthUser, decode_token
from .services import RequestService

_bearer = HTTPBearer(auto_error=False)


def get_service(request: Request) -> RequestService:
    return request.app.state.service


def get_engine(request: Request) -> ProcessingEngine:
    return request.app.state.engine


def get_publisher(request: Request) -> EventPublisher:
    return request.app.state.publisher


def get_manager(request: Request) -> ConnectionManager:
    return request.app.state.manager


def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
) -> AuthUser:
    if credentials is None:
        raise AuthError("Authentication required")
    return decode_token(credentials.credentials, request.app.state.settings.secret_key)


CurrentUser = Annotated[AuthUser, Depends(current_user)]
Service = Annotated[RequestService, Depends(get_service)]
Engine = Annotated[ProcessingEngine, Depends(get_engine)]
Publisher = Annotated[EventPublisher, Depends(get_publisher)]
