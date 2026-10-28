// Application entry: wires the store, REST API, WebSocket and components together.
import { ApiError, api, setToken, setUnauthorizedHandler } from "./api.js";
import { createStore } from "./store.js";
import { LiveConnection } from "./socket.js";
import { toast } from "./components/toast.js";
import { initLedger, renderLedger } from "./components/ledger.js";
import { renderRows, updateRow } from "./components/rows.js";
import { closeDrawer, isDrawerOpen, openDrawer, patchDrawerProgress, renderDrawer, setDrawerLoading } from "./components/drawer.js";
import { initRequestForm } from "./components/requestForm.js";

const $ = (id) => document.getElementById(id);
const SESSION_KEY = "servicedesk.session";
const PAGE_SIZE = 10;
const EMPTY_FILTERS = { q: "", status: "", priority: "", category: "", sort: "newest" };

const store = createStore({
  user: null,
  conn: "connecting",
  items: [],
  total: 0,
  page: 1,
  pages: 1,
  loading: false,
  filters: { ...EMPTY_FILTERS },
  stats: null,
  selectedId: null,
});

let live = null;
let listRequestId = 0; // guards against out-of-order responses
let reloadTimer = null;
const flashIds = new Set();
const knownStatus = new Map(); // id -> last status we saw, used to decide when to toast

/* ------------------------------------------------------------------ data */

async function loadList() {
  const { filters, page } = store.get();
  const mine = ++listRequestId;
  store.set({ loading: true });
  try {
    const result = await api.list({ ...filters, page, page_size: PAGE_SIZE });
    if (mine !== listRequestId) return;
    if (page > result.pages) { store.set({ page: result.pages }); return loadList(); }
    result.items.forEach((r) => knownStatus.set(r.id, r.status));
    store.set({ items: result.items, total: result.total, pages: result.pages, loading: false });
  } catch (err) {
    if (mine !== listRequestId) return;
    store.set({ loading: false });
    toast(err.message, "error");
  }
}

function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(loadList, 250);
}

async function loadStats() {
  try { store.set({ stats: await api.stats() }); } catch { /* the WebSocket will deliver them */ }
}

function matchesFilters(req, f) {
  if (f.status && req.status !== f.status) return false;
  if (f.priority && req.priority !== f.priority) return false;
  if (f.category && req.category !== f.category) return false;
  if (f.q) {
    const needle = f.q.toLowerCase();
    return [req.title, req.description, req.reference].some((t) => t.toLowerCase().includes(needle));
  }
  return true;
}

/** Merge a request pushed by the server (or returned by a REST call) into what is on screen. */
function applyChange(req) {
  const { items, filters, page, total } = store.get();
  const idx = items.findIndex((r) => r.id === req.id);
  const matches = matchesFilters(req, filters);

  if (idx >= 0) {
    flashIds.add(req.id);
    if (matches) {
      store.set({ items: items.map((r) => (r.id === req.id ? req : r)) });
    } else {
      store.set({ items: items.filter((r) => r.id !== req.id), total: Math.max(0, total - 1) });
      scheduleReload(); // pull in the next row to fill the page
    }
  } else if (matches) {
    if (page === 1 && filters.sort === "newest") {
      flashIds.add(req.id);
      store.set({ items: [req, ...items].slice(0, PAGE_SIZE), total: total + 1 });
    } else {
      scheduleReload();
    }
  }
}

function applyProgress(req) {
  const { items } = store.get();
  if (items.some((r) => r.id === req.id)) {
    store.set({ items: items.map((r) => (r.id === req.id ? req : r)) });
  }
  if (isDrawerOpen() && store.get().selectedId === req.id) patchDrawerProgress(req);
}

function announceStatusChange(req) {
  const previous = knownStatus.get(req.id);
  knownStatus.set(req.id, req.status);
  if (previous === req.status) return;
  if (req.status === "COMPLETED") toast(`${req.reference} completed`, "ok");
  else if (req.status === "FAILED") toast(`${req.reference} failed: ${req.failure_reason ?? "unknown reason"}`, "error");
}

/* ------------------------------------------------------------ WebSocket */

function handleLiveEvent({ type, data }) {
  switch (type) {
    case "stats.updated":
      store.set({ stats: data });
      break;
    case "request.progress":
      applyProgress(data);
      break;
    case "request.created":
    case "request.updated":
      announceStatusChange(data);
      applyChange(data);
      if (isDrawerOpen() && store.get().selectedId === data.id) showDetail(data.id, { quiet: true });
      break;
    default:
      break; // connection.ready, pong
  }
}

function startLive() {
  live?.stop();
  live = new LiveConnection({
    getToken: () => store.get().token,
    onEvent: handleLiveEvent,
    onState: (conn) => store.set({ conn }),
    onReconnect: () => { loadList(); loadStats(); },
    onAuthFailed: () => { toast("Your session expired. Please sign in again.", "error"); signOut(); },
  });
  live.start();
}

/* ------------------------------------------------------------ rendering */

function renderBoard(state) {
  const { items, loading, filters, page, pages, total } = state;
  renderRows($("rows"), items, { flashIds });
  flashIds.clear();

  const empty = $("empty");
  const filtered = Object.entries(filters).some(([k, v]) => k !== "sort" && v);
  empty.hidden = loading || items.length > 0;
  if (!empty.hidden) {
    empty.innerHTML = filtered
      ? "<strong>No requests match these filters</strong>Try a different search or clear a filter."
      : "<strong>No requests yet</strong>Use “New request” to submit the first one.";
  }

  $("prev").disabled = page <= 1;
  $("next").disabled = page >= pages;
  $("page-info").textContent = total ? `Page ${page} of ${pages}, ${total} request${total === 1 ? "" : "s"}` : "";
  document.querySelector(".pager").hidden = pages <= 1 && page <= 1;
}

function renderConnection({ conn }) {
  const labels = { live: "Live", connecting: "Connecting", offline: "Reconnecting" };
  const node = $("conn");
  node.dataset.state = conn;
  node.lastElementChild.textContent = labels[conn];
}

store.subscribe((state, changed) => {
  if (changed.some((k) => ["items", "loading", "page", "pages", "total", "filters"].includes(k))) renderBoard(state);
  if (changed.some((k) => ["stats", "user"].includes(k))) renderLedger(state.stats, state.user?.role === "SUPERVISOR");
  if (changed.includes("conn")) renderConnection(state);
});

/* --------------------------------------------------------------- drawer */

async function showDetail(id, { quiet = false } = {}) {
  store.set({ selectedId: id });
  if (!quiet) { openDrawer(); setDrawerLoading(); }
  try {
    const detail = await api.get(id);
    if (store.get().selectedId !== id) return;
    renderDrawer(detail, { onEdit: startEdit, onCancel: cancelRequest, onRetry: retryRequest });
  } catch (err) {
    closeDrawer();
    toast(err.message, "error");
  }
}

function startEdit(detail) {
  closeDrawer();
  form.open(detail);
}

async function cancelRequest(detail) {
  if (!window.confirm(`Cancel ${detail.reference}? This can't be undone.`)) return;
  try {
    const updated = await api.cancel(detail.id);
    knownStatus.set(updated.id, updated.status);
    applyChange(updated);
    toast(`${updated.reference} cancelled`);
    showDetail(detail.id, { quiet: true });
  } catch (err) { toast(err.message, "error"); }
}

async function retryRequest(detail) {
  try {
    const updated = await api.retry(detail.id);
    knownStatus.set(updated.id, updated.status);
    applyChange(updated);
    toast(`${updated.reference} is back in the queue`);
    showDetail(detail.id, { quiet: true });
  } catch (err) { toast(err.message, "error"); }
}

/* ----------------------------------------------------------- form wiring */

const form = initRequestForm({
  async onSubmit(payload, editingId) {
    if (editingId) {
      const updated = await api.update(editingId, payload);
      applyChange(updated);
      toast(`${updated.reference} updated`, "ok");
    } else {
      const created = await api.create(payload);
      knownStatus.set(created.id, created.status);
      applyChange(created);
      toast(`${created.reference} submitted`, "ok");
    }
  },
});

/* --------------------------------------------------------- session / auth */

function showView(signedIn) {
  $("login-view").hidden = signedIn;
  $("board-view").hidden = !signedIn;
}

async function enterApp(user, token) {
  setToken(token);
  store.set({ user, token, items: [], total: 0, page: 1, pages: 1, filters: { ...EMPTY_FILTERS }, stats: null, conn: "connecting" });
  $("user-name").textContent = user.full_name;
  $("user-role").textContent = user.role.toLowerCase();
  showView(true);
  startLive();
  await Promise.all([loadList(), loadStats()]);
}

function signOut() {
  live?.stop();
  live = null;
  localStorage.removeItem(SESSION_KEY);
  setToken(null);
  closeDrawer();
  store.set({ user: null, token: null });
  showView(false);
  $("login-form").reset();
  $("login-username").focus();
}

async function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? "null");
    if (!saved) throw new Error("none");
    setToken(saved.token);
    const user = await api.me();
    await enterApp(user, saved.token);
  } catch {
    signOut();
  }
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = $("login-error");
  error.hidden = true;
  const button = e.target.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const { token, user } = await api.login($("login-username").value.trim(), $("login-password").value);
    localStorage.setItem(SESSION_KEY, JSON.stringify({ token }));
    await enterApp(user, token);
  } catch (err) {
    error.textContent = err instanceof ApiError ? err.message : "Could not sign in";
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
});

document.querySelectorAll("[data-demo]").forEach((btn) =>
  btn.addEventListener("click", () => {
    $("login-username").value = btn.dataset.demo;
    $("login-password").value = "Password123!";
    $("login-password").focus();
  })
);

$("logout").addEventListener("click", signOut);
setUnauthorizedHandler(() => { toast("Your session expired. Please sign in again.", "error"); signOut(); });

/* ---------------------------------------------------------- UI events */

let searchTimer = null;
function setFilter(patch) {
  store.set({ filters: { ...store.get().filters, ...patch }, page: 1 });
  loadList();
}

$("f-q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => setFilter({ q: e.target.value.trim() }), 300);
});
[["f-status", "status"], ["f-priority", "priority"], ["f-category", "category"], ["f-sort", "sort"]].forEach(([id, key]) =>
  $(id).addEventListener("change", (e) => setFilter({ [key]: e.target.value }))
);

$("prev").addEventListener("click", () => { store.set({ page: store.get().page - 1 }); loadList(); });
$("next").addEventListener("click", () => { store.set({ page: store.get().page + 1 }); loadList(); });
$("new-request").addEventListener("click", () => form.open());

$("rows").addEventListener("click", (e) => {
  const row = e.target.closest(".row");
  if (row) showDetail(Number(row.dataset.id));
});
$("rows").addEventListener("keydown", (e) => {
  const row = e.target.closest(".row");
  if (row && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); showDetail(Number(row.dataset.id)); }
});

$("drawer-close").addEventListener("click", closeDrawer);
$("scrim").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && isDrawerOpen()) closeDrawer(); });

// Keep "5m ago" labels fresh without hitting the server.
setInterval(() => {
  const { items } = store.get();
  document.querySelectorAll(".row").forEach((rowEl) => {
    const req = items.find((r) => r.id === Number(rowEl.dataset.id));
    if (req) updateRow(rowEl, req);
  });
}, 30_000);

initLedger();
restoreSession();
