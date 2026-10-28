import { RAIL_WEIGHTS } from "../format.js";

// Builds the segmented progress rail once; `setRail` only moves the fills afterwards.
export function createRail(large = false) {
  const rail = document.createElement("div");
  rail.className = large ? "rail rail-lg" : "rail";
  rail.setAttribute("role", "progressbar");
  rail.setAttribute("aria-valuemin", "0");
  rail.setAttribute("aria-valuemax", "100");
  RAIL_WEIGHTS.forEach((weight) => {
    const seg = document.createElement("span");
    seg.style.flex = String(weight);
    seg.append(document.createElement("i"));
    rail.append(seg);
  });
  return rail;
}

export function setRail(rail, progress) {
  rail.setAttribute("aria-valuenow", String(progress));
  let start = 0;
  [...rail.children].forEach((seg, i) => {
    const share = RAIL_WEIGHTS[i];
    const filled = Math.min(1, Math.max(0, (progress - start) / share));
    seg.firstChild.style.width = `${filled * 100}%`;
    start += share;
  });
}
