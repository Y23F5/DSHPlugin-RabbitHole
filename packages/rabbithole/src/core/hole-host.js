/** @typedef {import("./contracts/engine.js").HoleNode} HoleNode */
import { projectNode } from "./hole/node.js";

/**
 * Create a debounced, serialized persistence queue. `save` is called at flush
 * time so hosts can capture their snapshot synchronously; it returns the write
 * operation that is then serialized behind earlier writes.
 *
 * @param {{ save: () => (() => Promise<unknown>), debounceMs: number, onTimerChange?: (timer: ReturnType<typeof setTimeout> | null) => void }} options
 */
export function createSaveChain({ save, debounceMs, onTimerChange = () => {} }) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  /** @type {Promise<unknown>} */
  let savingChain = Promise.resolve();
  let changeVersion = 0;
  let persistedVersion = 0;
  let queuedVersion = 0;

  function markDirty() {
    changeVersion += 1;
  }

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      onTimerChange(null);
    }
    // Visibility changes, exports, route transitions, and disposal can all ask
    // for durability after the latest version is already queued. Reuse that
    // promise instead of cloning and writing the whole hole again.
    if (changeVersion <= queuedVersion) return savingChain;
    const version = changeVersion;
    const write = save();
    queuedVersion = version;
    savingChain = savingChain.catch(() => {}).then(write).then((result) => {
      persistedVersion = Math.max(persistedVersion, version);
      return result;
    }, (error) => {
      // Retry a failed latest write on the next flush. A newer queued write
      // already contains this state, so an older failure must not dirty it.
      if (queuedVersion === version) queuedVersion = persistedVersion;
      throw error;
    });
    return savingChain;
  }

  function schedule() {
    markDirty();
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    onTimerChange(timer);
  }

  function cancel() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    onTimerChange(null);
  }

  return { markDirty, schedule, flush, cancel };
}

/**
 * @param {{ deletedNodes: Iterable<object>, remainingNodes: Iterable<object>, extractRefs: (node: object) => Iterable<string> }} options
 * @returns {string[]}
 */
export function assetsOrphanedByDeletion({ deletedNodes, remainingNodes, extractRefs }) {
  const deletedRefs = new Set();
  for (const node of deletedNodes) {
    for (const name of extractRefs(node)) deletedRefs.add(name);
  }
  if (!deletedRefs.size) return [];

  for (const node of remainingNodes) {
    for (const name of extractRefs(node)) deletedRefs.delete(name);
    if (!deletedRefs.size) return [];
  }
  return [...deletedRefs];
}

/** @param {HoleNode} node @param {Record<string, unknown>} [overrides] */
export function buildNodeAnsweredEvent(node, overrides = {}) {
  const projected = projectNode(node, "wire");
  const { id, ...fields } = projected;
  return {
    type: "node_answered",
    node_id: id,
    ...fields,
    ...overrides,
  };
}

/**
 * Apply a browser event to canonical state and request its debounced persist.
 * @param {any} payload
 * @param {{ dispatch: (event: any) => unknown, scheduleSave: () => void }} host
 */
export function applyPersistedBrowserEvent(payload, { dispatch, scheduleSave }) {
  dispatch({ ...payload, type: String(payload?.type ?? "") });
  scheduleSave();
  return { ok: true };
}

/**
 * Dispatch the browser event vocabulary while hosts retain the transport and
 * side effects behind each handler.
 *
 * @param {unknown} payload
 * @param {{ handlers: Record<string, (payload: any) => any>, unsupported: (type: string) => never }} options
 */
export function dispatchBrowserEvent(payload, { handlers, unsupported }) {
  const type = String(/** @type {any} */ (payload)?.type ?? "");
  const handler = handlers[type];
  return handler ? handler(payload) : unsupported(type);
}
