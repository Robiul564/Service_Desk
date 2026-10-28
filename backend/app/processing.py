"""Background processing engine.

A fixed pool of asyncio worker tasks pulls request ids from a priority queue
and walks each request through the processing steps. All waiting is
``await asyncio.sleep`` and every database call is pushed to a thread with
``asyncio.to_thread``, so the event loop - and therefore the REST API and the
WebSocket connections - stays responsive while many requests are processed at
the same time.

Cancellation needs no shared flags: every progress update is a conditional
UPDATE that only matches rows still IN_PROGRESS. If a user cancelled the
request, the update matches nothing and the worker walks away.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import random
from typing import TYPE_CHECKING

from .config import Settings
from .domain import PRIORITY_RANK, PROCESSING_STEPS, Priority
from .services import RequestService

if TYPE_CHECKING:
    from .realtime import EventPublisher

logger = logging.getLogger(__name__)

FAILURE_STEP_INDEX = 2  # "Performing service" is where things can go wrong
FAILURE_REASONS = (
    "No technician available in the service area",
    "Customer could not be reached to confirm the visit",
    "Required part is out of stock",
)


class ProcessingEngine:
    def __init__(self, service: RequestService, publisher: "EventPublisher", settings: Settings) -> None:
        self._service = service
        self._publisher = publisher
        self._settings = settings
        self._rng = random.Random()
        self._seq = itertools.count()  # keeps FIFO order inside one priority level
        self._queue: asyncio.PriorityQueue | None = None
        self._workers: list[asyncio.Task] = []
        self.active: set[int] = set()

    # ---- lifecycle -------------------------------------------------------
    async def start(self) -> None:
        self._queue = asyncio.PriorityQueue()
        for request_id, priority in await asyncio.to_thread(self._service.recover_interrupted):
            self.enqueue(request_id, priority)
        self._workers = [
            asyncio.create_task(self._worker_loop(n), name=f"worker-{n}")
            for n in range(1, self._settings.worker_count + 1)
        ]
        logger.info("Processing engine started with %d workers", len(self._workers))

    async def stop(self) -> None:
        for task in self._workers:
            task.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()

    # ---- public ----------------------------------------------------------
    def enqueue(self, request_id: int, priority: Priority) -> None:
        """Safe to call twice for one id: a second pickup finds it no longer PENDING and is skipped."""
        assert self._queue is not None, "engine not started"
        self._queue.put_nowait((PRIORITY_RANK[priority], next(self._seq), request_id))

    @property
    def queue_size(self) -> int:
        return self._queue.qsize() if self._queue else 0

    @property
    def worker_count(self) -> int:
        return len(self._workers)

    # ---- workers ---------------------------------------------------------
    async def _worker_loop(self, number: int) -> None:
        assert self._queue is not None
        while True:
            _, _, request_id = await self._queue.get()
            try:
                await self._process(request_id, number)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Worker %d crashed while processing request %s", number, request_id)
                failed = await asyncio.to_thread(self._service.fail, request_id, "Unexpected processing error")
                if failed:
                    await self._publisher.request_updated(failed)
            finally:
                self.active.discard(request_id)
                self._queue.task_done()

    async def _process(self, request_id: int, worker: int) -> None:
        started = await asyncio.to_thread(self._service.begin_processing, request_id)
        if started is None:
            return  # cancelled while waiting in the queue
        self.active.add(request_id)
        logger.info("worker-%d started %s", worker, started.reference)
        await self._publisher.request_updated(started)

        ticks = self._settings.ticks_per_step
        tick_delay = self._settings.step_delay_seconds / ticks
        will_fail = self._rng.random() < self._settings.failure_rate
        progress = 0

        for index, (label, target) in enumerate(PROCESSING_STEPS):
            first = progress
            for tick in range(1, ticks + 1):
                await asyncio.sleep(tick_delay * self._rng.uniform(0.7, 1.3))

                if will_fail and index == FAILURE_STEP_INDEX and tick == max(1, ticks // 2):
                    failed = await asyncio.to_thread(self._service.fail, request_id, self._rng.choice(FAILURE_REASONS))
                    if failed:
                        logger.info("worker-%d: %s failed", worker, failed.reference)
                        await self._publisher.request_updated(failed)
                    return

                progress = first + round((target - first) * tick / ticks)
                if progress >= 100:
                    break  # the final 100% is written by complete() below
                updated = await asyncio.to_thread(self._service.record_progress, request_id, progress, label)
                if updated is None:
                    logger.info("worker-%d: request %s was cancelled, stopping", worker, request_id)
                    return
                await self._publisher.request_progress(updated)

        done = await asyncio.to_thread(self._service.complete, request_id)
        if done:
            logger.info("worker-%d finished %s", worker, done.reference)
            await self._publisher.request_updated(done)
