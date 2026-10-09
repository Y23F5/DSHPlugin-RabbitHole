/**
 * RabbitHole's harness event vocabulary.
 *
 * The vocabulary deliberately mirrors the useful part of DeepSeek Harness'
 * append-only session log without importing its developer-preview internals.
 * A future DSH transport can therefore feed the same events to Rabbithole.
 */
export const HARNESS_EVENT_TYPES = Object.freeze({
  USER_MESSAGE: "user/message",
  RUN_STARTED: "run/started",
  REQUEST_CONTEXT: "request/context",
  ASSISTANT_MESSAGE: "assistant/message",
  ASSISTANT_ATTEMPT: "assistant/attempt",
  ASSISTANT_REASONING_START: "assistant/reasoning/start",
  ASSISTANT_REASONING_DELTA: "assistant/reasoning/delta",
  ASSISTANT_REASONING_END: "assistant/reasoning/end",
  ASSISTANT_TEXT_START: "assistant/text/start",
  ASSISTANT_TEXT_DELTA: "assistant/text/delta",
  ASSISTANT_TEXT_END: "assistant/text/end",
  AGENT_STARTED: "agent/started",
  AGENT_STATUS: "agent/status",
  TOOL_CALL: "tool/call",
  TOOL_CALL_START: "tool/call/start",
  TOOL_CALL_DELTA: "tool/call/delta",
  TOOL_CALL_END: "tool/call/end",
  TOOL_RESULT: "tool/result",
  APPROVAL_REQUEST: "approval/request",
  APPROVAL_RESULT: "approval/result",
  SKILL_ACTIVATED: "skill/activated",
  SKILL_CONFIGURED: "skill/configured",
  FILE_READ: "file/read",
  FILE_WRITE: "file/write",
  PLAN_UPDATE: "plan/update",
  RUN_STATUS: "run/status",
  RUN_COMPLETED: "run/completed",
  RUN_ERROR: "run/error",
});

export function createHarnessEvent(type, payload = {}, { sessionId = "", runId = "", nodeId = "", projectId = "" } = {}) {
  return {
    type: String(type || HARNESS_EVENT_TYPES.RUN_STATUS),
    at: new Date().toISOString(),
    session_id: String(sessionId || ""),
    run_id: String(runId || ""),
    node_id: String(nodeId || ""),
    project_id: String(projectId || ""),
    ...payload,
  };
}

export function isHarnessEvent(value) {
  return !!value && typeof value === "object" && typeof value.type === "string" && typeof value.at === "string";
}

export function summarizeHarnessEvent(event) {
  if (!isHarnessEvent(event)) return null;
  const { raw, payload, ...record } = event;
  return JSON.parse(JSON.stringify(record));
}

export const HARNESS_CAPABILITIES = Object.freeze([
  "session_log",
  "project_context",
  "skills",
  "tools",
  "read_only_files",
  "interruptible_runs",
]);
