"""SQLAlchemy models: users, service requests, and the status audit trail."""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, Enum, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from .database import Base, UTCDateTime, utcnow
from .domain import Category, Priority, Role, Status


def _enum(e):
    # Stored as short strings with a CHECK constraint, portable across databases.
    return Enum(e, native_enum=False, length=20, create_constraint=True, validate_strings=True)


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)
    full_name: Mapped[str] = mapped_column(String(100), nullable=False)
    role: Mapped[Role] = mapped_column(_enum(Role), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)


class ServiceRequest(Base):
    __tablename__ = "service_requests"
    __table_args__ = (
        CheckConstraint("progress >= 0 AND progress <= 100", name="ck_progress_range"),
        Index("ix_requests_status", "status"),
        Index("ix_requests_owner_created", "created_by", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    reference: Mapped[str] = mapped_column(String(32), unique=True, nullable=False)
    title: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[Category] = mapped_column(_enum(Category), nullable=False)
    priority: Mapped[Priority] = mapped_column(_enum(Priority), default=Priority.MEDIUM, nullable=False)
    status: Mapped[Status] = mapped_column(_enum(Status), default=Status.PENDING, nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    current_step: Mapped[str | None] = mapped_column(String(80))
    failure_reason: Mapped[str | None] = mapped_column(String(255))

    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(UTCDateTime)
    completed_at: Mapped[datetime | None] = mapped_column(UTCDateTime)

    creator: Mapped[User] = relationship(lazy="joined")
    events: Mapped[list["RequestEvent"]] = relationship(
        back_populates="request",
        cascade="all, delete-orphan",
        order_by="RequestEvent.id",
    )

    @property
    def created_by_name(self) -> str:
        return self.creator.full_name


class RequestEvent(Base):
    """Append-only history of status changes (the audit trail)."""

    __tablename__ = "request_events"
    __table_args__ = (Index("ix_events_request", "request_id"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    request_id: Mapped[int] = mapped_column(ForeignKey("service_requests.id", ondelete="CASCADE"), nullable=False)
    from_status: Mapped[Status | None] = mapped_column(_enum(Status))
    to_status: Mapped[Status] = mapped_column(_enum(Status), nullable=False)
    message: Mapped[str] = mapped_column(String(255), nullable=False)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, nullable=False)

    request: Mapped[ServiceRequest] = relationship(back_populates="events")
