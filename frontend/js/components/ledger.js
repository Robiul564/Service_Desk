import { STATUS_LABEL, duration } from "../format.js";

const ORDER = [
  ["pending", "PENDING"],
  ["in_progress", "IN_PROGRESS"],
  ["completed", "COMPLETED"],
  ["failed", "FAILED"],
  ["cancelled", "CANCELLED"],
];

const bar = () => document.getElementById("ledger-bar");
const counts = () => document.getElementById("ledger-counts");

export function initLedger() {
  counts().innerHTML = ORDER.map(
    ([key, status]) =>
      `<div class="s-${status}"><dt><i style="background:var(--c)"></i>${STATUS_LABEL[status]}</dt><dd data-count="${key}">0</dd></div>`
  ).join("");
  bar().innerHTML = ORDER.map(([, status]) => `<span class="s-${status}" style="background:var(--c);flex-grow:0"></span>`).join("");
}

export function renderLedger(stats, isSupervisor) {
  document.getElementById("scope-title").textContent = isSupervisor ? "All requests (Supervisor Monitor)" : "Your requests";
  if (!stats) return;
  ORDER.forEach(([key], i) => {
    counts().querySelector(`[data-count="${key}"]`).textContent = stats[key];
    bar().children[i].style.flexGrow = String(stats[key]);
  });
  const note = document.getElementById("ledger-note");
  note.textContent = stats.total
    ? `${stats.total} in total. Average run time ${duration(stats.avg_completion_seconds)}`
    : "Nothing here yet";
}
