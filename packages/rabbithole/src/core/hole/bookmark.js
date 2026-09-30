/** @typedef {import("../contracts/artifact.js").PersistedViewState} PersistedViewState */

/** @param {unknown} state @returns {Omit<PersistedViewState, "mode"> | null} */
export function normalizeBookmark(state) {
  if (!state || typeof state !== "object") return null;
  const raw = /** @type {Record<string, any>} */ (state);
  /** @type {Omit<PersistedViewState, "mode">} */
  const out = {
    node_id: typeof raw.node_id === "string" ? raw.node_id.slice(0, 128) : null,
    scroll: Math.max(0, Number(raw.scroll) || 0),
  };
  if (raw.view && typeof raw.view === "object") {
    out.view = {
      x: Number(raw.view.x) || 0,
      y: Number(raw.view.y) || 0,
      scale: Math.min(2.5, Math.max(0.15, Number(raw.view.scale) || 1)),
    };
  }
  return out;
}

/** Schema-v2 compatibility projection; `mode` is ignored by the product. @param {unknown} state @returns {PersistedViewState | null} */
export function normalizeViewState(state) {
  const bookmark = normalizeBookmark(state);
  if (!bookmark) return null;
  return { mode: /** @type {any} */ (state).mode === "canvas" ? "canvas" : "reader", ...bookmark };
}
