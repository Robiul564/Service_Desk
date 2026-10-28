import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, timeAgo } from "../format.js";
import { createRail, setRail } from "./rail.js";

const STATUS_CLASSES = ["s-PENDING", "s-IN_PROGRESS", "s-COMPLETED", "s-FAILED", "s-CANCELLED"];

function createRow(req) {
  const li = document.createElement("li");
  li.className = "row";
  li.dataset.id = req.id;
  li.tabIndex = 0;
  li.setAttribute("role", "button");
  li.innerHTML = `
    <div class="row-main">
      <span class="ref" data-f="ref"></span>
      <h3 class="row-title" data-f="title"></h3>
      <p class="row-meta">
        <span class="prio" data-f="priority"></span>
        <span data-f="category"></span>
        <span data-f="owner"></span>
        <span data-f="created"></span>
      </p>
    </div>
    <div class="row-status">
      <span class="badge" data-f="status"></span>
      <span class="step" data-f="step"></span>
    </div>
    <div class="row-rail">
      <div data-f="rail"></div>
      <div class="pct"><span data-f="pct"></span></div>
    </div>`;
  li.querySelector('[data-f="rail"]').replaceWith(createRail());
  return li;
}

const field = (el, name) => el.querySelector(`[data-f="${name}"]`);

export function updateRow(el, req, { flash = false } = {}) {
  field(el, "ref").textContent = req.reference;
  field(el, "title").textContent = req.title;
  field(el, "title").title = req.title;

  const prio = field(el, "priority");
  prio.textContent = PRIORITY_LABEL[req.priority];
  prio.className = `prio prio-${req.priority}`;

  field(el, "category").textContent = CATEGORY_LABEL[req.category];
  field(el, "owner").textContent = req.created_by_name;
  field(el, "created").textContent = timeAgo(req.created_at);

  field(el, "status").textContent = STATUS_LABEL[req.status];
  el.classList.remove(...STATUS_CLASSES);
  el.classList.add(`s-${req.status}`);

  field(el, "step").textContent =
    req.status === "IN_PROGRESS" ? req.current_step ?? "" :
    req.status === "FAILED" ? req.failure_reason ?? "" : "";

  setRail(el.querySelector(".rail"), req.progress);
  field(el, "pct").textContent = req.status === "PENDING" ? "Waiting in queue" : `${req.progress}%`;

  if (flash) {
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 900);
  }
}

// Keyed reconciliation: rows for requests we already show are updated in place
// (so progress bars animate smoothly) instead of being rebuilt.
export function renderRows(container, items, { flashIds = new Set() } = {}) {
  const existing = new Map([...container.children].map((el) => [Number(el.dataset.id), el]));
  const ordered = items.map((req) => {
    let el = existing.get(req.id);
    if (el) existing.delete(req.id);
    else el = createRow(req);
    updateRow(el, req, { flash: flashIds.has(req.id) });
    return el;
  });
  existing.forEach((el) => el.remove());
  ordered.forEach((el, i) => {
    if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null);
  });
}
