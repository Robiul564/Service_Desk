import { CATEGORY_LABEL, PRIORITY_LABEL, STATUS_LABEL, fullDate } from "../format.js";
import { createRail, setRail } from "./rail.js";

const $ = (id) => document.getElementById(id);
let lastFocus = null;

export function isDrawerOpen() { return !$("drawer").hidden; }

export function openDrawer() {
  lastFocus = document.activeElement;
  $("scrim").hidden = false;
  $("drawer").hidden = false;
  $("drawer-close").focus();
}

export function closeDrawer() {
  $("scrim").hidden = true;
  $("drawer").hidden = true;
  lastFocus?.focus?.();
}

export function setDrawerLoading() {
  $("drawer-ref").textContent = "";
  $("drawer-title").textContent = "Loading…";
  $("drawer-body").replaceChildren();
  $("drawer-actions").replaceChildren();
}

// Cheap in-place update used for the frequent progress events.
export function patchDrawerProgress(req) {
  const rail = $("drawer-body").querySelector(".rail");
  if (!rail) return;
  setRail(rail, req.progress);
  const step = $("drawer-body").querySelector("[data-d='step']");
  if (step) step.textContent = req.status === "IN_PROGRESS" ? `${req.current_step} · ${req.progress}%` : `${req.progress}%`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderDrawer(detail, { onEdit, onCancel, onRetry }) {
  $("drawer-ref").textContent = detail.reference;
  $("drawer-title").textContent = detail.title;

  const body = $("drawer-body");
  const statusClass = `s-${detail.status}`;

  const top = el("div", `d-progress ${statusClass}`);
  const row = el("div", "d-progress-top");
  row.append(el("span", "badge", STATUS_LABEL[detail.status]));
  const stepText = detail.status === "IN_PROGRESS" ? `${detail.current_step} · ${detail.progress}%` :
    detail.status === "PENDING" ? "Waiting in queue" : `${detail.progress}%`;
  const step = el("span", "muted", stepText);
  step.dataset.d = "step";
  row.append(step);
  const rail = createRail(true);
  setRail(rail, detail.progress);
  top.append(row, rail);
  if (detail.failure_reason) top.append(el("p", "alert", detail.failure_reason));

  const desc = el("p", "d-desc", detail.description);

  const facts = el("dl", "facts");
  [
    ["Category", CATEGORY_LABEL[detail.category]],
    ["Priority", PRIORITY_LABEL[detail.priority]],
    ["Requested by", detail.created_by_name],
    ["Submitted", fullDate(detail.created_at)],
    ["Started", fullDate(detail.started_at)],
    ["Finished", fullDate(detail.completed_at)],
  ].forEach(([label, value]) => {
    const wrap = el("div");
    wrap.append(el("dt", null, label), el("dd", null, value));
    facts.append(wrap);
  });

  const history = el("section");
  history.append(el("h2", null, "History"));
  const list = el("ol", "timeline");
  [...detail.events].reverse().forEach((ev) => {
    const li = el("li", `s-${ev.to_status}`);
    li.append(el("div", null, ev.message), el("div", "when", fullDate(ev.created_at)));
    list.append(li);
  });
  history.append(list);

  body.replaceChildren(top, desc, facts, history);

  const actions = $("drawer-actions");
  actions.replaceChildren();
  if (detail.status === "PENDING") {
    const edit = el("button", "btn btn-quiet", "Edit");
    edit.onclick = () => onEdit(detail);
    actions.append(edit);
  }
  if (detail.status === "FAILED") {
    const retry = el("button", "btn btn-primary", "Retry");
    retry.onclick = () => onRetry(detail);
    actions.append(retry);
  }
  if (detail.status === "PENDING" || detail.status === "IN_PROGRESS") {
    const cancel = el("button", "btn btn-danger", "Cancel request");
    cancel.onclick = () => onCancel(detail);
    actions.append(cancel);
  }
}
