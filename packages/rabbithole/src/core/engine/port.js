import { normalizeClock } from "../clock.js";

/** @param {any} port */
export function assertEnginePort(port) {
  if (!port || typeof port !== "object") throw new TypeError("HoleEngine port is required");
  if (!port.store || typeof port.store.saveHole !== "function") {
    throw new TypeError("HoleEngine port.store must save holes");
  }
  if (typeof port.emit !== "function") throw new TypeError("HoleEngine port.emit must be a function");
  if (!port.ids || typeof port.ids.newId !== "function") throw new TypeError("HoleEngine port.ids.newId must be a function");
  const store = typeof port.store.deleteAsset === "function"
    ? port.store
    : { ...port.store, deleteAsset: async () => {} };
  return Object.freeze({ ...port, store, clock: normalizeClock(port.clock) });
}
