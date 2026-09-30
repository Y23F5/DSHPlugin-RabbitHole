import { createHoleState, holeStateToHole, reduceHoleEvent } from "../../core/hole/reduce.js";
import { normalizeBlockIds } from "../../core/blocks.js";
import { truncate } from "../../core/hole/lens.js";
import { makeNode } from "../../core/hole/node.js";
import { randomId } from "../../core/utils.js";
import { createWhimsicalHoleId } from "../hole-id.js";
import { DirectHostGeneration } from "./direct-host-generation.js";
import { WEB_ROOT_QUESTION, rootQuestionForNode, titleFromMarkdown } from "./direct-host-values.js";

export { generationDocEvents } from "./direct-host-values.js";

/** Subscription delivery and persistence lifecycle for the web adapter. */
export class DirectRabbitholeHost extends DirectHostGeneration {
  isLivePending(nodeId) {
    const node = this.state.nodes.get(nodeId);
    return !!node && node.status === "pending";
  }

  emit(event) {
    this.lastEventId += 1;
    this.onEvent?.(event);
  }

  scheduleSave() {
    if (this.disposed) return;
    this.engine.scheduleSave();
  }

  flushSave() {
    if (this.disposed) return this.savingChain;
    this.savingChain = this.engine.flushSave();
    return this.savingChain;
  }

  dispose() {
    if (this.disposed) return this.savingChain;
    this.disposed = true;
    this.engine.cancelSave();
    for (const controller of this.abortByNode.values()) {
      try { controller.abort(); } catch {}
    }
    this.abortByNode.clear();
    this.noteConversions.clear();
    for (const subscription of [...this.subscriptions]) subscription.close();
    this.onEvent = null;
    return this.savingChain;
  }}

export function createHoleFromMarkdown({ title = "", markdown = "", baseUrl = null } = {}) {
  const now = new Date().toISOString();
  const holeId = createWhimsicalHoleId();
  const rootId = randomId("root");
  const inferredTitle = title || titleFromMarkdown(markdown) || "Untitled";
  return {
    hole_id: holeId,
    title: inferredTitle,
    root_id: rootId,
    created_at: now,
    view_state: null,
    nodes: [makeNode({
      id: rootId,
      parent_id: null,
      title: inferredTitle,
      markdown: normalizeBlockIds(String(markdown || "")).markdown,
      base_url: baseUrl,
      base_url_source: baseUrl ? "explicit" : null,
      origin: null,
      position: { x: 0, y: 0 },
      size: null,
      status: "answered",
      read: true,
      created_at: now,
    })],
  };
}

export function createPendingHoleFromQuestion(question) {
  const normalized = String(question || "").trim();
  const title = truncate(normalized, 80) || "Untitled";
  const hole = createHoleFromMarkdown({ title, markdown: "" });
  const root = hole.nodes[0];
  root.status = "pending";
  const result = reduceHoleEvent(createHoleState(/** @type {any} */ (hole)), {
    type: "node_origin",
    node_id: root.id,
    origin: { [WEB_ROOT_QUESTION]: normalized },
  });
  return holeStateToHole(result.state);
}
