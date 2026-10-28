"""Data access. Only this module builds SQL; the service layer never does."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from sqlalchemy import case, func, or_, select, update
from sqlalchemy.orm import Session

from .database import utcnow
from .domain import PRIORITY_RANK, Category, Priority, Status
from .models import RequestEvent, ServiceRequest, User


@dataclass
class SearchParams:
    owner_id: int | None = None
    status: Status | None = None
    priority: Priority | None = None
    category: Category | None = None
    text: str | None = None
    sort: str = "newest"
    page: int = 1
    page_size: int = 10


class RequestRepository:
    def __init__(self, session: Session) -> None:
        self.s = session

    # ---- users -----------------------------------------------------------
    def get_user_by_username(self, username: str) -> User | None:
        return self.s.scalar(select(User).where(func.lower(User.username) == username.lower()))

    def count_users(self) -> int:
        return self.s.scalar(select(func.count(User.id))) or 0

    def add_user(self, user: User) -> User:
        self.s.add(user)
        self.s.flush()
        return user

    # ---- requests --------------------------------------------------------
    def add(self, req: ServiceRequest) -> ServiceRequest:
        self.s.add(req)
        self.s.flush()
        return req

    def get(self, request_id: int) -> ServiceRequest | None:
        return self.s.get(ServiceRequest, request_id)

    def refresh(self, req: ServiceRequest) -> ServiceRequest:
        self.s.refresh(req)
        return req

    def add_event(self, request_id: int, from_status: Status | None, to_status: Status, message: str) -> None:
        self.s.add(RequestEvent(request_id=request_id, from_status=from_status, to_status=to_status, message=message))

    def compare_and_set_status(
        self, request_id: int, expected: Iterable[Status], new_status: Status, **values
    ) -> bool:
        """Atomic transition: only succeeds if the row is still in an expected status.

        This is what keeps a cancel click and a worker finishing the same
        request at the same moment from overwriting each other.
        """
        result = self.s.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == request_id, ServiceRequest.status.in_(list(expected)))
            .values(status=new_status, updated_at=utcnow(), **values)
        )
        return result.rowcount == 1

    def update_progress(self, request_id: int, progress: int, step: str) -> bool:
        result = self.s.execute(
            update(ServiceRequest)
            .where(ServiceRequest.id == request_id, ServiceRequest.status == Status.IN_PROGRESS)
            .values(progress=progress, current_step=step, updated_at=utcnow())
        )
        return result.rowcount == 1

    def ids_with_status(self, status: Status) -> list[tuple[int, Priority]]:
        rows = self.s.execute(
            select(ServiceRequest.id, ServiceRequest.priority)
            .where(ServiceRequest.status == status)
            .order_by(ServiceRequest.created_at)
        )
        return [(r.id, r.priority) for r in rows]

    # ---- queries ---------------------------------------------------------
    def _filtered(self, p: SearchParams):
        stmt = select(ServiceRequest)
        if p.owner_id is not None:
            stmt = stmt.where(ServiceRequest.created_by == p.owner_id)
        if p.status:
            stmt = stmt.where(ServiceRequest.status == p.status)
        if p.priority:
            stmt = stmt.where(ServiceRequest.priority == p.priority)
        if p.category:
            stmt = stmt.where(ServiceRequest.category == p.category)
        if p.text:
            escaped = p.text.lower().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            like = f"%{escaped}%"
            stmt = stmt.where(
                or_(
                    func.lower(ServiceRequest.title).like(like, escape="\\"),
                    func.lower(ServiceRequest.description).like(like, escape="\\"),
                    func.lower(ServiceRequest.reference).like(like, escape="\\"),
                )
            )
        return stmt

    def search(self, p: SearchParams) -> tuple[list[ServiceRequest], int]:
        base = self._filtered(p)
        total = self.s.scalar(select(func.count()).select_from(base.order_by(None).subquery())) or 0

        priority_order = case(
            {prio: rank for prio, rank in PRIORITY_RANK.items()}, value=ServiceRequest.priority
        )
        orderings = {
            "newest": (ServiceRequest.created_at.desc(), ServiceRequest.id.desc()),
            "oldest": (ServiceRequest.created_at.asc(), ServiceRequest.id.asc()),
            "priority": (priority_order.asc(), ServiceRequest.created_at.desc()),
            "progress": (ServiceRequest.progress.desc(), ServiceRequest.created_at.desc()),
        }
        stmt = (
            base.order_by(*orderings.get(p.sort, orderings["newest"]))
            .limit(p.page_size)
            .offset((p.page - 1) * p.page_size)
        )
        return list(self.s.scalars(stmt).unique()), total

    def status_counts(self, owner_id: int | None) -> dict[Status, int]:
        stmt = select(ServiceRequest.status, func.count()).group_by(ServiceRequest.status)
        if owner_id is not None:
            stmt = stmt.where(ServiceRequest.created_by == owner_id)
        return {status: count for status, count in self.s.execute(stmt)}

    def recent_completions(self, owner_id: int | None, limit: int = 50) -> list[tuple]:
        stmt = (
            select(ServiceRequest.started_at, ServiceRequest.completed_at)
            .where(ServiceRequest.status == Status.COMPLETED, ServiceRequest.started_at.is_not(None))
            .order_by(ServiceRequest.completed_at.desc())
            .limit(limit)
        )
        if owner_id is not None:
            stmt = stmt.where(ServiceRequest.created_by == owner_id)
        return [(r.started_at, r.completed_at) for r in self.s.execute(stmt)]
