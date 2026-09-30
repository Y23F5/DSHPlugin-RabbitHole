import { randomId } from "../../core/utils.js";
import { createHarnessEvent, HARNESS_CAPABILITIES, HARNESS_EVENT_TYPES } from "./protocol.js";

const MAX_CONTEXT_CHARS = 28000;

/**
 * Wraps the current Rabbithole provider in a harness-shaped event stream.
 *
 * This is intentionally provider-neutral: OpenAI-compatible, Claude and Codex
 * bridges all receive the same session/run metadata. A real DSH transport can
 * later implement the same `wrapProvider` contract and take over tool calls.
 */
export class RabbitholeHarnessProvider {
  constructor(provider, { sessionId = "", projectId = "", runId = "", nodeId = "", kind = "branch", onEvent = null } = {}) {
    if (!provider) throw new TypeError("A provider is required for the harness adapter");
    this.provider = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider);
    this.sessionId = sessionId || `rh-session-${randomId("session")}`;
    this.projectId = projectId;
    this.runId = runId || randomId("run");
    this.nodeId = nodeId;
    this.kind = kind;
    this.onEvent = onEvent;
    this.provider.onHarnessEvent = (type, payload) => this.emit(type, payload);
    this.provider.projectId = projectId;
    this.provenance = { ...(provider.provenance || {}), harness: "rabbithole-local" };
  }

  capabilities() {
    return [...HARNESS_CAPABILITIES, "provider_stream"];
  }

  async *answerBranch(context, signal) {
    yield* this.stream(this.provider.answerBranch(context, signal), { context });
  }

  async *authorExplainer(context, signal) {
    yield* this.stream(this.provider.authorExplainer(context, signal), { context });
  }

  async *authorDocument(source, signal) {
    yield* this.stream(this.provider.authorDocument(source, signal), { context: source });
  }

  async *stream(source, { context }) {
    const question = context?.question || context?.selected_text || context?.instruction || "";
    if (question) this.emit(HARNESS_EVENT_TYPES.USER_MESSAGE, { text: String(question) });
    this.emit(HARNESS_EVENT_TYPES.RUN_STARTED, { kind: this.kind });
    this.emit(HARNESS_EVENT_TYPES.REQUEST_CONTEXT, { context: compactContext(context) });
    for (const skill of context?.project_context?.skills || []) this.emit("skill/activated", { skill: skill.name || skill.id, source: "project context" });
    try {
      for await (const event of source) {
        if (event.type === "text" && event.delta) this.emit(HARNESS_EVENT_TYPES.ASSISTANT_MESSAGE, { delta: event.delta, text: event.delta });
        else if (event?.type && event.type !== "text") {
          const { type: eventType, ...payload } = event;
          this.emit(eventType, payload);
        }
        yield event;
      }
      this.emit(HARNESS_EVENT_TYPES.RUN_COMPLETED, { status: "completed" });
    } catch (error) {
      this.emit(HARNESS_EVENT_TYPES.RUN_ERROR, { status: "failed", message: error?.message || String(error) });
      throw error;
    }
  }

  emit(type, payload) {
    this.onEvent?.(createHarnessEvent(type, payload, {
      sessionId: this.sessionId,
      runId: this.runId,
      nodeId: this.nodeId,
      projectId: this.projectId,
    }));
  }
}

export function createHarnessProvider(provider, options = {}) {
  if (!provider) return null;
  if (provider.provenance?.harness?.startsWith?.("deepseek-")) {
    provider = Object.assign(Object.create(Object.getPrototypeOf(provider)), provider);
    provider.sessionId = options.sessionId || provider.sessionId;
    provider.projectId = options.projectId || provider.projectId;
    provider.runId = options.runId || provider.runId;
    provider.nodeId = options.nodeId || provider.nodeId;
    provider.kind = options.kind || provider.kind;
    provider.onEvent = options.onEvent || provider.onEvent;
    return provider;
  }
  return new RabbitholeHarnessProvider(provider, options);
}

function compactContext(value) {
  if (value == null) return null;
  try {
    const json = JSON.stringify(value);
    if (json.length <= MAX_CONTEXT_CHARS) return value;
    return { truncated: true, excerpt: json.slice(0, MAX_CONTEXT_CHARS) };
  } catch {
    return { unavailable: true };
  }
}
