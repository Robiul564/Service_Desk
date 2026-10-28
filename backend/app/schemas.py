"""Pydantic schemas: request validation and response shapes."""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .domain import Category, Priority, Role, Status


class RequestCreate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str = Field(min_length=3, max_length=120)
    description: str = Field(min_length=10, max_length=2000)
    category: Category
    priority: Priority = Priority.MEDIUM


class RequestUpdate(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    title: str | None = Field(default=None, min_length=3, max_length=120)
    description: str | None = Field(default=None, min_length=10, max_length=2000)
    category: Category | None = None
    priority: Priority | None = None

    @model_validator(mode="after")
    def _needs_a_change(self):
        if not self.model_fields_set:
            raise ValueError("Provide at least one field to update")
        return self


class RequestOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    reference: str
    title: str
    description: str
    category: Category
    priority: Priority
    status: Status
    progress: int
    current_step: str | None
    failure_reason: str | None
    created_by: int
    created_by_name: str
    created_at: datetime
    updated_at: datetime
    started_at: datetime | None
    completed_at: datetime | None


class EventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    from_status: Status | None
    to_status: Status
    message: str
    created_at: datetime


class RequestDetail(RequestOut):
    events: list[EventOut]


class Page(BaseModel):
    items: list[RequestOut]
    total: int
    page: int
    page_size: int
    pages: int


class StatsOut(BaseModel):
    total: int
    pending: int
    in_progress: int
    completed: int
    failed: int
    cancelled: int
    avg_completion_seconds: float | None


class LoginIn(BaseModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=128)


class UserOut(BaseModel):
    id: int
    username: str
    full_name: str
    role: Role


class TokenOut(BaseModel):
    token: str
    user: UserOut
