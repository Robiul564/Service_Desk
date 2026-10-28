from __future__ import annotations

from fastapi import APIRouter, Request
from starlette.concurrency import run_in_threadpool

from ..dependencies import CurrentUser, Service
from ..schemas import LoginIn, TokenOut, UserOut
from ..security import create_token

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=TokenOut)
async def login(payload: LoginIn, service: Service, request: Request) -> TokenOut:
    user = await run_in_threadpool(service.authenticate, payload.username, payload.password)
    settings = request.app.state.settings
    token = create_token(user, settings.secret_key, settings.token_ttl_minutes)
    return TokenOut(token=token, user=UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role))


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return UserOut(id=user.id, username=user.username, full_name=user.full_name, role=user.role)
