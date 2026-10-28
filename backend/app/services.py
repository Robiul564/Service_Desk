"""Business rules. Methods are synchronous and open their own short-lived
session, so callers (API handlers, background workers) run them in a thread
and never block the event loop."""
from __future__ import annotations

import logging
import math
import uuid
from contextlib import contextmanager
from typing import Iterator

from sqlalchemy.orm import Session, sessionmaker

from .database import utcnow
from .domain import ALLOWED_TRANSITIONS, PROCESSING_STEPS, Priority, Role, Status
from .errors import AuthError, ConflictError, NotFoundError
from .models import ServiceRequest, User
from .repository import RequestRepository, SearchParams
from .schemas import (
    EventOut,
    Page,
    RequestCreate,
    RequestDetail,
    RequestOut,
    RequestUpdate,
    StatsOut,
)
from .security import AuthUser, hash_password, verify_password

logger = logging.getLogger(__name__)

DEMO_USERS = (
    ("alice", "Alice Operator", Role.OPERATOR),
    ("bob", "Bob Operator", Role.OPERATOR),
    ("sam", "Sam Supervisor", Role.SUPERVISOR),
)
DEMO_PASSWORD = "Password123!"


class RequestService:
    def __init__(self, session_factory: sessionmaker) -> None:
        self._session_factory = session_factory

    @contextmanager
    def _tx(self) -> Iterator[tuple[Session, RequestRepository]]:
        session = self._session_factory()
        try:
            yield session, RequestRepository(session)
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    # ---- helpers ---------------------------------------------------------
    @staticmethod
    def _visible(user: AuthUser, req: ServiceRequest | None) -> ServiceRequest:
        # Operators asking for someone else's request get the same answer as for
        # a missing one, so ids can't be probed.
        if req is None or (not user.is_supervisor and req.created_by != user.id):
            raise NotFoundError("Service request not found")
        return req

    @staticmethod
    def _transition(
        repo: RequestRepository,
        req: ServiceRequest,
        new_status: Status,
        message: str,
        **values,
    ) -> ServiceRequest:
        current = req.status
        if new_status not in ALLOWED_TRANSITIONS[current]:
            raise ConflictError(f"Cannot move a request from {current.value} to {new_status.value}")
        if not repo.compare_and_set_status(req.id, {current}, new_status, **values):
            raise ConflictError("The request was changed by someone else, please refresh")
        repo.add_event(req.id, current, new_status, message)
        repo.s.flush()
        repo.s.expire(req)
        return req

    # ---- users / auth ----------------------------------------------------
    def seed_demo_users(self) -> None:
        with self._tx() as (_, repo):
            if repo.count_users():
                return
            for username, name, role in DEMO_USERS:
                repo.add_user(
                    User(username=username, full_name=name, role=role, password_hash=hash_password(DEMO_PASSWORD))
                )
        logger.info("Seeded demo users (password: %s)", DEMO_PASSWORD)

    def authenticate(self, username: str, password: str) -> AuthUser:
        with self._tx() as (_, repo):
            user = repo.get_user_by_username(username)
            if user is None or not verify_password(password, user.password_hash):
                raise AuthError("Incorrect username or password")
            return AuthUser(user.id, user.username, user.full_name, user.role)

    # ---- user-facing operations -----------------------------------------
    def create(self, user: AuthUser, data: RequestCreate) -> RequestOut:
        with self._tx() as (s, repo):
            req = repo.add(
                ServiceRequest(
                    reference=f"tmp-{uuid.uuid4().hex}",  # replaced once the id is known
                    title=data.title,
                    description=data.description,
                    category=data.category,
                    priority=data.priority,
                    created_by=user.id,
                )
            )
            req.reference = f"SR-{req.id:05d}"
            repo.add_event(req.id, None, Status.PENDING, f"Submitted by {user.full_name}")
            s.flush()
            repo.refresh(req)
            return RequestOut.model_validate(req)

    def list(self, user: AuthUser, params: SearchParams) -> Page:
        params.owner_id = None if user.is_supervisor else user.id
        with self._tx() as (_, repo):
            rows, total = repo.search(params)
            return Page(
                items=[RequestOut.model_validate(r) for r in rows],
                total=total,
                page=params.page,
                page_size=params.page_size,
                pages=max(1, math.ceil(total / params.page_size)),
            )

    def get(self, user: AuthUser, request_id: int) -> RequestDetail:
        with self._tx() as (_, repo):
            req = self._visible(user, repo.get(request_id))
            base = RequestOut.model_validate(req).model_dump()
            events = [EventOut.model_validate(e) for e in req.events]
            return RequestDetail(**base, events=events)

    def update(self, user: AuthUser, request_id: int, data: RequestUpdate) -> RequestOut:
        with self._tx() as (s, repo):
            req = self._visible(user, repo.get(request_id))
            if req.status != Status.PENDING:
                raise ConflictError("Only pending requests can be edited")
            for field in data.model_fields_set:
                setattr(req, field, getattr(data, field))
            req.updated_at = utcnow()
            s.flush()
            return RequestOut.model_validate(req)

    def cancel(self, user: AuthUser, request_id: int) -> RequestOut:
        with self._tx() as (_, repo):
            req = self._visible(user, repo.get(request_id))
            self._transition(repo, req, Status.CANCELLED, f"Cancelled by {user.full_name}")
            return RequestOut.model_validate(repo.refresh(req))

    def retry(self, user: AuthUser, request_id: int) -> RequestOut:
        with self._tx() as (_, repo):
            req = self._visible(user, repo.get(request_id))
            self._transition(
                repo, req, Status.PENDING, f"Retry requested by {user.full_name}",
                progress=0, current_step=None, failure_reason=None, started_at=None,
            )
            return RequestOut.model_validate(repo.refresh(req))

    def stats(self, owner_id: int | None) -> StatsOut:
        with self._tx() as (_, repo):
            counts = repo.status_counts(owner_id)
            durations = [
                (done - start).total_seconds()
                for start, done in repo.recent_completions(owner_id)
                if start and done
            ]
            return StatsOut(
                total=sum(counts.values()),
                pending=counts.get(Status.PENDING, 0),
                in_progress=counts.get(Status.IN_PROGRESS, 0),
                completed=counts.get(Status.COMPLETED, 0),
                failed=counts.get(Status.FAILED, 0),
                cancelled=counts.get(Status.CANCELLED, 0),
                avg_completion_seconds=round(sum(durations) / len(durations), 1) if durations else None,
            )

    # ---- operations used by the background workers -----------------------
    def recover_interrupted(self) -> list[tuple[int, Priority]]:
        """After a restart: put interrupted work back in line and return everything queued."""
        with self._tx() as (_, repo):
            for request_id, _prio in repo.ids_with_status(Status.IN_PROGRESS):
                req = repo.get(request_id)
                self._transition(
                    repo, req, Status.FAILED, "Interrupted by a server restart",
                    failure_reason="Interrupted by a server restart",
                )
                self._transition(
                    repo, req, Status.PENDING, "Re-queued automatically after restart",
                    progress=0, current_step=None, failure_reason=None, started_at=None,
                )
            return repo.ids_with_status(Status.PENDING)

    def begin_processing(self, request_id: int) -> RequestOut | None:
        with self._tx() as (_, repo):
            req = repo.get(request_id)
            if req is None:
                return None
            ok = repo.compare_and_set_status(
                request_id, {Status.PENDING}, Status.IN_PROGRESS,
                progress=0, current_step=PROCESSING_STEPS[0][0], started_at=utcnow(),
            )
            if not ok:
                return None  # cancelled while queued, or picked up twice
            repo.add_event(request_id, Status.PENDING, Status.IN_PROGRESS, "Processing started")
            repo.s.flush()
            return RequestOut.model_validate(repo.refresh(req))

    def record_progress(self, request_id: int, progress: int, step: str) -> RequestOut | None:
        with self._tx() as (_, repo):
            if not repo.update_progress(request_id, progress, step):
                return None  # no longer in progress (cancelled) - worker should stop
            return RequestOut.model_validate(repo.refresh(repo.get(request_id)))

    def complete(self, request_id: int) -> RequestOut | None:
        with self._tx() as (_, repo):
            ok = repo.compare_and_set_status(
                request_id, {Status.IN_PROGRESS}, Status.COMPLETED,
                progress=100, current_step="Done", completed_at=utcnow(),
            )
            if not ok:
                return None
            repo.add_event(request_id, Status.IN_PROGRESS, Status.COMPLETED, "Completed successfully")
            repo.s.flush()
            return RequestOut.model_validate(repo.refresh(repo.get(request_id)))

    def fail(self, request_id: int, reason: str) -> RequestOut | None:
        with self._tx() as (_, repo):
            ok = repo.compare_and_set_status(
                request_id, {Status.IN_PROGRESS}, Status.FAILED, failure_reason=reason[:255]
            )
            if not ok:
                return None
            repo.add_event(request_id, Status.IN_PROGRESS, Status.FAILED, f"Failed: {reason}"[:255])
            repo.s.flush()
            return RequestOut.model_validate(repo.refresh(repo.get(request_id)))
