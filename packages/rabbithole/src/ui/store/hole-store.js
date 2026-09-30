const DEFAULT_STATE = Object.freeze({
  hydration: null,
  rootId: null,
  frozen: false,
  currentNodeId: null,
  mode: "canvas",
  view: null,
  closed: false,
  closedReason: null,
  phase: "open",
});

export function createHoleStore(initial = {}) {
  const listeners = new Set();
  const state = {};
  let childrenByParent = Object.create(null);

  function reset(next = {}) {
    const previousKeys = Object.keys(state);
    for (const key of previousKeys) delete state[key];
    Object.assign(state, DEFAULT_STATE, next, {
      nodes: Object.create(null),
      view: { x: 0, y: 0, scale: 1, ...(next.view || {}) },
    });
    childrenByParent = Object.create(null);
    emit(new Set(Object.keys(state)));
    return state;
  }

  function patch(values) {
    const changed = new Set();
    for (const [key, value] of Object.entries(values || {})) {
      if (Object.is(state[key], value)) continue;
      state[key] = value;
      changed.add(key);
    }
    if (changed.size) emit(changed);
    return state;
  }

  function register(node) {
    if (!node?.id) return node;
    if (state.nodes[node.id]) remove(node.id);
    state.nodes[node.id] = node;
    if (node.parent_id != null) (childrenByParent[node.parent_id] ||= []).push(node);
    emit(new Set(["nodes"]));
    return node;
  }

  function remove(id) {
    const node = state.nodes[id];
    if (!node) return null;
    const siblings = node.parent_id == null ? null : childrenByParent[node.parent_id];
    if (siblings) {
      const index = siblings.indexOf(node);
      if (index !== -1) siblings.splice(index, 1);
      if (!siblings.length) delete childrenByParent[node.parent_id];
    }
    delete state.nodes[id];
    emit(new Set(["nodes"]));
    return node;
  }

  function childrenOf(id) {
    const siblings = childrenByParent[id];
    if (!siblings) return [];
    return siblings.some((node) => node._pendingDelete) ? siblings.filter((node) => !node._pendingDelete) : siblings;
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("HoleStore listener must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function emit(invalidated) {
    for (const listener of listeners) listener(state, invalidated);
  }

  reset(initial);
  return Object.freeze({ state, reset, patch, register, remove, childrenOf, subscribe });
}
