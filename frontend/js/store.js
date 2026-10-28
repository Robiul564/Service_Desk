// A very small observable store. Components subscribe to the slices they care about
// and the store tells them when those slices change.

export function createStore(initial) {
  let state = initial;
  const listeners = new Set();

  return {
    get: () => state,
    set(patch) {
      const next = { ...state, ...(typeof patch === "function" ? patch(state) : patch) };
      const changed = Object.keys(next).filter((k) => next[k] !== state[k]);
      if (!changed.length) return;
      state = next;
      listeners.forEach((fn) => fn(state, changed));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
