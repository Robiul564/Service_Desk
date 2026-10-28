"""Application factory and wiring."""
from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from .config import Settings, load_settings
from .database import build_engine, build_session_factory, init_db
from .errors import AppError
from .processing import ProcessingEngine
from .realtime import ConnectionManager, EventPublisher
from .routers import auth, requests, system, ws
from .services import RequestService

logger = logging.getLogger("app")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()
    logging.basicConfig(
        level=settings.log_level,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    db_engine = build_engine(settings.database_url)
    service = RequestService(build_session_factory(db_engine))
    manager = ConnectionManager()
    publisher = EventPublisher(manager, service)
    engine = ProcessingEngine(service, publisher, settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        init_db(db_engine)
        if settings.seed_demo_users:
            await run_in_threadpool(service.seed_demo_users)
        await engine.start()
        try:
            yield
        finally:
            await engine.stop()
            db_engine.dispose()

    app = FastAPI(
        title="Service Request Management API",
        version="1.0.0",
        description="Submit service requests, process them in the background and watch them live over WebSockets.",
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine_db = db_engine
    app.state.service = service
    app.state.manager = manager
    app.state.publisher = publisher
    app.state.engine = engine

    if settings.cors_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(settings.cors_origins),
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.middleware("http")
    async def log_requests(request: Request, call_next):
        started = time.perf_counter()
        response = await call_next(request)
        elapsed_ms = (time.perf_counter() - started) * 1000
        if request.url.path.startswith("/api"):
            logger.info("%s %s -> %d (%.0f ms)", request.method, request.url.path, response.status_code, elapsed_ms)
        response.headers["X-Process-Time-ms"] = f"{elapsed_ms:.0f}"
        return response

    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError):
        return JSONResponse(status_code=exc.status_code, content={"error": {"code": exc.code, "message": exc.message}})

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError):
        details = [
            {
                "field": ".".join(str(p) for p in e["loc"] if p not in ("body", "query", "path")),
                "message": e["msg"].removeprefix("Value error, "),
            }
            for e in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={"error": {"code": "validation_error", "message": "Please check the highlighted fields", "details": details}},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(_: Request, exc: Exception):
        logger.exception("Unhandled error", exc_info=exc)
        return JSONResponse(
            status_code=500,
            content={"error": {"code": "internal_error", "message": "Something went wrong on our side"}},
        )

    app.include_router(auth.router)
    app.include_router(requests.router)
    app.include_router(system.router)
    app.include_router(ws.router)

    # The single-page frontend is served last so it never shadows an API route.
    if settings.frontend_dir.is_dir():
        app.mount("/", StaticFiles(directory=settings.frontend_dir, html=True), name="frontend")

    return app

