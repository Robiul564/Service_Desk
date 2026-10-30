from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from ..dependencies import CurrentUser, Service
from ..errors import RateLimitError
from ..schemas import LoginIn, TokenOut, UserOut, WsTicketOut
from ..security import check_login_rate, clear_login_rate, create_token, create_ws_ticket

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut)
async def login(payload: LoginIn, service: Service, request: Request) -> TokenOut:
    # Rate-limit by client IP before we even touch the database.
    client_ip = request.client.host if request.client else "unknown"
    check_login_rate(client_ip)

    user = await run_in_threadpool(service.authenticate, payload.username, payload.password)
    # Login succeeded — clear the failure counter for this IP.
    clear_login_rate(client_ip)

    settings = request.app.state.settings
    token = create_token(user, settings.secret_key, settings.token_ttl_minutes)
    return TokenOut(token=token, user=UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role))


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role)


@router.post(
    "/ws-ticket",
    response_model=WsTicketOut,
    summary="Exchange your Bearer token for a short-lived WebSocket ticket",
    description=(
        "Returns a single-use ticket that is valid for 30 seconds. "
        "Pass it as `?ticket=<value>` when opening the WebSocket connection "
        "instead of sending the long-lived Bearer token in the URL."
    ),
)
async def ws_ticket(user: CurrentUser) -> WsTicketOut:
    return WsTicketOut(ticket=create_ws_ticket(user))
