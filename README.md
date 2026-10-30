# Service Desk: real-time service request management

Operators submit service requests. A pool of background workers processes many of them at the same time.
Supervisors (and the operators who own the requests) watch status and progress change **live over WebSockets**,
with no polling and no page refresh.

- Backend: Python, FastAPI, SQLAlchemy, SQLite (PostgreSQL-ready)
- Frontend: vanilla JavaScript (ES modules), no build step
- Real time: native WebSockets
- Concurrency: asyncio worker pool with a priority queue, database calls offloaded to threads
- Extras: role-based access, login rate limiting, WebSocket ticket auth, automated tests, Docker, GitHub Actions CI, health endpoint, request logging

Documents for the assessment:

| Deliverable | File |
|-------------|------|
| System analysis (problem, users, assumptions, scope, functional and non-functional requirements) | [docs/01-system-analysis.md](docs/01-system-analysis.md) |
| System design (architecture, components, ERD, API, WebSocket flow, concurrency, stack justification) | [docs/02-system-design.md](docs/02-system-design.md) |
| This README (setup, run, API, WebSocket events, database) | you are here |

---

## 1. Quick start

You need **Python 3.11 or newer**. Nothing else (no Node, no database server).

```bash
cd backend
python -m venv .venv

# macOS / Linux
source .venv/bin/activate
# Windows (PowerShell)
# .venv\Scripts\Activate.ps1

pip install -r requirements.txt
python run.py
```

Open **http://localhost:8000**.

Demo accounts (password for all: `Password123!`):

| Username | Role |
|----------|------|
| `alice` | Operator |
| `bob` | Operator |
| `sam` | Supervisor |

**Best way to see it working:** open two browser windows. Sign in as `sam` in one and `alice` in the other.
Submit a few requests as Alice and watch Sam's board update live: new rows appear, progress rails fill,
counters change. Try cancelling a running request, and submit an *Urgent* one while others are queued.

Interactive API docs: http://localhost:8000/docs

### With Docker

```bash
docker compose up --build
```

Then open http://localhost:8000. Data is kept in a named volume.

### Cloud Deployment (Render / Railway / Docker)

This application is ready for 1-click cloud deployment on platforms supporting persistent WebSockets and background worker loops:

- **Render (Free Web Service)**:
  1. Push this repository to GitHub.
  2. Sign in to [Render.com](https://render.com) and click **New +** → **Blueprint** (or **Web Service**).
  3. Select your repository. Render automatically reads [`render.yaml`](render.yaml) and builds the container via the [`Dockerfile`](Dockerfile).
  4. Your live app is provisioned at `https://<your-subdomain>.onrender.com`.

- **Railway**:
  1. Push this repository to GitHub.
  2. In [Railway.app](https://railway.app), click **New Project** → **Deploy from GitHub repo**.
  3. Railway detects [`railway.json`](railway.json) and [`Dockerfile`](Dockerfile) and deploys automatically.

- **Any Cloud Host (AWS, GCP, DigitalOcean, Fly.io)**:
  Build and run the Docker container:
  ```bash
  docker build -t service-request-system .
  docker run -p 8000:8000 -e PORT=8000 service-request-system
  ```

### Run the tests

```bash
cd backend
pip install -r requirements-dev.txt
pytest
```

---

## 2. Configuration

All settings are environment variables. Copy `backend/.env.example` to `backend/.env` to change them.

| Variable | Default | Meaning |
|----------|---------|---------|
| `DATABASE_URL` | SQLite file in `backend/data/` | Any SQLAlchemy URL, e.g. `postgresql+psycopg://user:pass@host/db` (install the driver) |
| `SECRET_KEY` | dev value | Signs access tokens. **Change it** outside development |
| `TOKEN_TTL_MINUTES` | `480` | Session lifetime |
| `WORKER_COUNT` | `4` | Requests processed in parallel |
| `STEP_DELAY_SECONDS` | `2.0` | Simulated duration of each of the 5 processing steps |
| `TICKS_PER_STEP` | `3` | Progress updates per step |
| `FAILURE_RATE` | `0.08` | Share of requests that fail in the "Performing service" step |
| `SEED_DEMO_USERS` | `true` | Create the three demo users on first start |
| `LOG_LEVEL` | `INFO` | Python log level |
| `CORS_ORIGINS` | empty | Comma-separated origins, only needed if the UI is served from elsewhere |

Tip: set `STEP_DELAY_SECONDS=6` to make the concurrency easier to watch, or `FAILURE_RATE=0.5` to see failures and retries.

---

## 3. Architecture overview

```
 Browser                                   Server (one FastAPI process)
┌──────────────────────┐   REST (JSON)    ┌────────────────────────────────────────┐
│  UI (ES modules)     │ ───────────────► │ routers → service layer → repository ──┼──► SQLite / PostgreSQL
│  store · components  │                  │              │                         │
│                      │   WebSocket      │              ▼                         │
│  live connection     │ ◄─────────────── │ EventPublisher → ConnectionManager     │
└──────────────────────┘   push events    │              ▲                         │
                                          │ ProcessingEngine: priority queue +     │
                                          │ N async workers (DB work in threads)   │
                                          └────────────────────────────────────────┘
```

Backend layers (`backend/app/`):

| File | Responsibility |
|------|----------------|
| `routers/` | HTTP and WebSocket endpoints. Parse, delegate, return |
| `services.py` | Business rules, permissions, the status state machine |
| `repository.py` | All SQL |
| `processing.py` | Background worker pool and priority queue |
| `realtime.py` | WebSocket connections and event publishing |
| `models.py`, `database.py` | Tables, engine and session setup |
| `schemas.py`, `domain.py` | Validation rules and shared enums/transitions |
| `security.py`, `dependencies.py` | Password hashing, tokens, auth dependencies |
| `config.py`, `main.py` | Settings and app wiring |

Frontend (`frontend/`): `api.js` (REST client), `socket.js` (auto-reconnecting WebSocket), `store.js`
(state), `components/` (ledger, rows, drawer, form, toast), `main.js` (wiring).

How a request flows: **submit** (REST) → saved as `PENDING` and queued → a free worker **claims** it
(`IN_PROGRESS`) → five steps with progress ticks, each one pushed over the WebSocket → `COMPLETED` or `FAILED`.
A user can cancel at any point before the end. Full diagrams are in [docs/02-system-design.md](docs/02-system-design.md).

### Concurrency in one paragraph

Workers are asyncio tasks, so waiting costs nothing and the event loop stays free for API and WebSocket traffic.
Because the database layer is synchronous, every DB call runs in a thread via `asyncio.to_thread`. Shared state
lives only in the database and every status change is an atomic compare-and-set `UPDATE`, so a cancel and a
completion at the same moment cannot overwrite each other, and no in-memory locks are needed for correctness.

---

## 4. Technology stack

| Layer | Technology |
|-------|------------|
| API | FastAPI, uvicorn, Pydantic v2 |
| Persistence | SQLAlchemy 2.0, SQLite (WAL mode) |
| Real time | WebSockets (Starlette / uvicorn) |
| Frontend | HTML, CSS, JavaScript ES modules |
| Tests | pytest, FastAPI TestClient |
| Packaging | Docker, docker-compose, GitHub Actions |

Reasons for each choice are in section 2.7 of the design document.

---

## 5. Assumptions

- Processing is simulated with timed steps; replace `ProcessingEngine._process` to call real systems.
- Users are pre-created; there is no registration or password reset.
- Operators see only their own requests; supervisors see everything.
- A single server instance. The design doc explains how to scale out (PostgreSQL, Redis pub/sub, shared queue).
- Times are stored in UTC and displayed in the browser's local time zone.

---

## 6. API documentation

Base URL `http://localhost:8000/api`. Send `Authorization: Bearer <token>` on everything except login and health.
Live, try-it-out documentation is at `/docs`.

### Errors

```json
{ "error": { "code": "validation_error", "message": "Please check the highlighted fields",
             "details": [ { "field": "title", "message": "String should have at least 3 characters" } ] } }
```

| Status | `code` | Meaning |
|--------|--------|---------|
| 401 | `unauthorized` | Missing, invalid or expired token; bad credentials |
| 404 | `not_found` | No such request, or it belongs to another operator |
| 409 | `conflict` | Not allowed in the request's current status |
| 422 | `validation_error` | Invalid input, with per-field `details` |
| 500 | `internal_error` | Unexpected; details are in the server log only |

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/auth/login` | Body `{username, password}` returns `{token, user}` |
| GET | `/auth/me` | Current user |
| POST | `/auth/ws-ticket` | Returns a 30-second single-use `{ticket}` for the WebSocket connection |
| GET | `/requests` | List. Query: `status`, `priority`, `category`, `q`, `sort` (`newest`, `oldest`, `priority`, `progress`), `page`, `page_size` (1-100, default 10) |
| POST | `/requests` | Create. Body below. Returns `201` |
| GET | `/requests/stats` | `{total, pending, in_progress, completed, failed, cancelled, avg_completion_seconds}` |
| GET | `/requests/{id}` | Details including `events` (status history) |
| PATCH | `/requests/{id}` | Edit `title`, `description`, `category`, `priority` while `PENDING` |
| POST | `/requests/{id}/cancel` | Allowed from `PENDING` and `IN_PROGRESS` |
| POST | `/requests/{id}/retry` | Allowed from `FAILED` |
| GET | `/health` | `{status, database, workers, queued, processing, websocket_clients}` |

Create body:

```json
{ "title": "Replace office router",
  "description": "The router drops the connection every hour.",
  "category": "REPAIR",
  "priority": "HIGH" }
```

Allowed values: `category` is `INSTALLATION | MAINTENANCE | REPAIR | INQUIRY | OTHER`, `priority` is
`LOW | MEDIUM | HIGH | URGENT` (default `MEDIUM`). Title 3-120 characters, description 10-2000.

Example:

```bash
TOKEN=$(curl -s localhost:8000/api/auth/login -H 'Content-Type: application/json' \
        -d '{"username":"alice","password":"Password123!"}' | python -c "import sys,json;print(json.load(sys.stdin)['token'])")

curl -s localhost:8000/api/requests -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
     -d '{"title":"Install fibre line","description":"New office needs a fibre connection.","category":"INSTALLATION"}'
```

### Request object

```json
{ "id": 12, "reference": "SR-00012", "title": "...", "description": "...",
  "category": "REPAIR", "priority": "HIGH",
  "status": "IN_PROGRESS", "progress": 55, "current_step": "Performing service", "failure_reason": null,
  "created_by": 1, "created_by_name": "Alice Operator",
  "created_at": "2026-01-01T12:00:00Z", "updated_at": "...", "started_at": "...", "completed_at": null }
```

Statuses: `PENDING`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED`.

---

## 7. WebSocket events

Connect to `ws://localhost:8000/ws?ticket=<ticket>` (preferred) or `ws://localhost:8000/ws?token=<token>` (legacy).
Obtain a ticket first with `POST /api/auth/ws-ticket`. The ticket is single-use and valid for 30 seconds,
so it cannot become a persistent secret even if it appears in an access log.
An invalid credential is closed with code `4401`.
Every message is `{"type": string, "data": any, "ts": ISO-8601}`.

| Event | Sent when | `data` |
|-------|-----------|--------|
| `connection.ready` | after connecting | `{user, role}` |
| `stats.updated` | on connect and whenever counts change | stats object (same as `/requests/stats`) |
| `request.created` | a request is submitted | request object |
| `request.updated` | status or details change | request object |
| `request.progress` | progress or step changes while running | request object |
| `pong` | reply to the client's text message `ping` | `null` |

Supervisors receive events for all requests; operators only for their own. The browser client sends `ping` every
25 seconds and reconnects with exponential backoff; after reconnecting it reloads the list once to catch up.

Quick check from a terminal:

```bash
npx wscat -c "ws://localhost:8000/ws?token=$TOKEN"
```

---

## 8. Database

Three tables, created automatically on first start (no migration step needed):

- `users`: username (unique), full name, role, password hash
- `service_requests`: reference (unique), title, description, category, priority, status, progress (0-100 check),
  current step, failure reason, owner (FK), timestamps
- `request_events`: append-only status history per request (FK with cascade delete)

The ERD, constraints and indexes are in [docs/02-system-design.md](docs/02-system-design.md#23-database-design).
The SQLite file lives at `backend/data/service_requests.db`; delete it to start fresh. For PostgreSQL, set
`DATABASE_URL` and install a driver (for example `pip install "psycopg[binary]"`).

---

## 9. Testing

`pytest` runs 110 tests across 4 test suites against the real app (real HTTP, real WebSocket, real background workers, temporary database):

| Area | Examples |
|------|----------|
| Auth and permissions | login, invalid tokens, operators cannot see each other's requests |
| Validation and search | field-level errors, filters, sorting, pagination, wildcard escaping |
| Processing | full lifecycle, **parallel execution and non-blocking API**, cancel mid-flight, retry, urgent-first ordering |
| WebSocket | auth rejection, live events for supervisors, per-owner scoping, ping/pong, stats pushes |

CI (`.github/workflows/ci.yml`) runs them on Python 3.11 and 3.12 and builds the Docker image.

---

## 10. Possible next steps

Refresh tokens, Redis pub/sub for multi-instance fan-out, a shared queue
(`SELECT ... FOR UPDATE SKIP LOCKED`), Alembic migrations, user administration, pagination by cursor, end-to-end
browser tests.
