from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, Query
from starlette.concurrency import run_in_threadpool

from ..dependencies import CurrentUser, Engine, Publisher, Service
from ..domain import Category, Priority, Status
from ..repository import SearchParams
from ..schemas import Page, RequestCreate, RequestDetail, RequestOut, RequestUpdate, StatsOut

router = APIRouter(prefix="/api/requests", tags=["service requests"])


@router.get("/stats", response_model=StatsOut, summary="Dashboard counters for the caller's scope")
async def stats(user: CurrentUser, service: Service) -> StatsOut:
    return await run_in_threadpool(service.stats, None if user.is_supervisor else user.id)


@router.get("", response_model=Page, summary="Search and filter requests")
async def list_requests(
    user: CurrentUser,
    service: Service,
    status: Status | None = None,
    priority: Priority | None = None,
    category: Category | None = None,
    q: str | None = Query(default=None, max_length=100, description="Matches title, description or reference"),
    sort: Literal["newest", "oldest", "priority", "progress"] = "newest",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=10, ge=1, le=100),
) -> Page:
    params = SearchParams(
        status=status, priority=priority, category=category,
        text=(q or "").strip() or None, sort=sort, page=page, page_size=page_size,
    )
    return await run_in_threadpool(service.list, user, params)


@router.post("", response_model=RequestOut, status_code=201, summary="Submit a new service request")
async def create_request(
    payload: RequestCreate, user: CurrentUser, service: Service, engine: Engine, publisher: Publisher
) -> RequestOut:
    created = await run_in_threadpool(service.create, user, payload)
    engine.enqueue(created.id, created.priority)
    await publisher.request_created(created)
    return created


@router.get("/{request_id}", response_model=RequestDetail, summary="Request details with status history")
async def get_request(request_id: int, user: CurrentUser, service: Service) -> RequestDetail:
    return await run_in_threadpool(service.get, user, request_id)


@router.patch("/{request_id}", response_model=RequestOut, summary="Edit a pending request")
async def update_request(
    request_id: int, payload: RequestUpdate, user: CurrentUser,
    service: Service, engine: Engine, publisher: Publisher,
) -> RequestOut:
    updated = await run_in_threadpool(service.update, user, request_id, payload)
    if "priority" in payload.model_fields_set:
        engine.enqueue(updated.id, updated.priority)  # re-rank; the stale queue entry is skipped later
    await publisher.request_updated(updated)
    return updated


@router.post("/{request_id}/cancel", response_model=RequestOut, summary="Cancel a pending or running request")
async def cancel_request(request_id: int, user: CurrentUser, service: Service, publisher: Publisher) -> RequestOut:
    cancelled = await run_in_threadpool(service.cancel, user, request_id)
    await publisher.request_updated(cancelled)
    return cancelled


@router.post("/{request_id}/retry", response_model=RequestOut, summary="Re-queue a failed request")
async def retry_request(
    request_id: int, user: CurrentUser, service: Service, engine: Engine, publisher: Publisher
) -> RequestOut:
    retried = await run_in_threadpool(service.retry, user, request_id)
    engine.enqueue(retried.id, retried.priority)
    await publisher.request_updated(retried)
    return retried
