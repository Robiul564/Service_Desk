"""Domain vocabulary shared by every layer: enums and the status state machine."""
from __future__ import annotations

from enum import Enum


class Status(str, Enum):
    PENDING = "PENDING"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class Priority(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"
    URGENT = "URGENT"


class Category(str, Enum):
    INSTALLATION = "INSTALLATION"
    MAINTENANCE = "MAINTENANCE"
    REPAIR = "REPAIR"
    INQUIRY = "INQUIRY"
    OTHER = "OTHER"


class Role(str, Enum):
    OPERATOR = "OPERATOR"
    SUPERVISOR = "SUPERVISOR"


# Which status may follow which. Anything not listed is rejected with HTTP 409.
ALLOWED_TRANSITIONS: dict[Status, frozenset[Status]] = {
    Status.PENDING: frozenset({Status.IN_PROGRESS, Status.CANCELLED}),
    Status.IN_PROGRESS: frozenset({Status.COMPLETED, Status.FAILED, Status.CANCELLED}),
    Status.FAILED: frozenset({Status.PENDING}),  # retry
    Status.COMPLETED: frozenset(),
    Status.CANCELLED: frozenset(),
}

# Lower number = picked up first by the worker pool.
PRIORITY_RANK: dict[Priority, int] = {
    Priority.URGENT: 0,
    Priority.HIGH: 1,
    Priority.MEDIUM: 2,
    Priority.LOW: 3,
}

# (label shown to users, progress % reached when the step finishes)
PROCESSING_STEPS: tuple[tuple[str, int], ...] = (
    ("Validating request", 15),
    ("Assigning technician", 35),
    ("Performing service", 75),
    ("Quality check", 90),
    ("Closing request", 100),
)
