export { DOC_EVENT, HOST_COMMAND, WIRE_EVENT, assertHostCommandHandlers } from "../vocabulary.js";

/** @param {unknown} event */
export function eventType(event) {
  return String(/** @type {{ type?: unknown } | null | undefined} */ (event)?.type ?? "");
}

/** @param {unknown} event @param {Record<string, (event: any) => any>} handlers */
export function dispatchEvent(event, handlers) {
  const type = eventType(event);
  const handler = handlers[type];
  if (!handler) throw new Error(`Unsupported event: ${type}`);
  return handler(event);
}
