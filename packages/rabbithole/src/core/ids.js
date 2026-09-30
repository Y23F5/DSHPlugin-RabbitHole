/** @param {() => string} newId */
export function createIds(newId) {
  if (typeof newId !== "function") throw new TypeError("ids.newId must be a function");
  return Object.freeze({ newId });
}
