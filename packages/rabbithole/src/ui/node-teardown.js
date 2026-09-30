import { disposeNodeContent, nodes, readerMain, unregisterNode } from "./core.js";
import { dropNodeView } from "./store/node-view.js";
import { removeMarks } from "./text-marks.js";
import { refreshVisualMarks } from "./visuals.js";

/** @param {Record<string, any>} node */
export function detachNode(node) {
  if (!node) return;
  disposeNodeContent(node);
  dropNodeView(node);
}

/** @param {string} id */
export function teardownNode(id) {
  const node = nodes[id];
  if (!node) return;
  detachNode(node);
  removeMarks(readerMain, id);
  const parent = nodes[node.parent_id];
  if (parent && parent.bodyEl) removeMarks(parent.bodyEl, id);
  unregisterNode(id);
  const blockId = node.origin?.anchor?.block?.block_id;
  if (parent && blockId) refreshVisualMarks(parent.id, blockId);
}
