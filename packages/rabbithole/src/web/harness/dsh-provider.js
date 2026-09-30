import { buildAnswerMessages } from "../../core/prompts/answering-v1.js";
import { buildAuthorMessages } from "../../core/prompts/authoring-v1.js";
import { buildExplainerMessages } from "../../core/prompts/explainer-v1.js";
import { withProjectInstructions } from "../provider/project-prompt.js";
import { createHarnessEvent } from "./protocol.js";
import { ProviderError } from "../provider/errors.js";

const KNOWLEDGE_SEARCH_SYSTEM = [
  "You answer a knowledge question inside RabbitHole.",
  "This is a web-search question. Do not use RabbitHole project files, parent documents, or project_* tools.",
  "Before writing the answer, call the web_search tool with a focused query. Use the returned pages as evidence.",
  "If web_search is unavailable or returns no usable result, say so clearly and do not invent current facts.",
  "Write markdown only. Start with TITLE: <short topic title> on the first line.",
  "After the answer, include a short Sources section with the pages or URLs returned by web search.",
].join("\n");

function buildKnowledgeSearchMessages(context) {
  return [
    { role: "system", content: KNOWLEDGE_SEARCH_SYSTEM },
    { role: "user", content: `Knowledge question:\n${String(context?.question || context?.selected_text || "").trim() || "(empty)"}` },
  ];
}

export class DshBrowserProvider {
  constructor({ mode = "auto", endpoint = "/api/harness/run", provider = "deepseek-official", model = "deepseek-flash", reasoningEffort = "", sessionId = "", projectId = "", runId = "", nodeId = "", kind = "branch", onEvent = null } = {}) {
    this.mode = mode; this.endpoint = endpoint; this.providerName = provider; this.model = model || "deepseek-flash"; this.reasoningEffort = reasoningEffort; this.sessionId = sessionId; this.projectId = projectId; this.runId = runId; this.nodeId = nodeId; this.kind = kind; this.onEvent = onEvent;
    this.provenance = { provider: `dsh:${mode}`, model: this.model, reasoning: reasoningEffort, harness: `deepseek-${mode}` };
  }
  capabilities() { return ["session", "agent_loop", "tools", "skills", "file_events", this.mode]; }
  async *answerBranch(context, signal) {
    const input = context || {};
    if (input.ask_mode === "web_search") {
      yield* this.run(buildKnowledgeSearchMessages(input), { ...input, project_context: null, knowledge_search: true }, signal);
      return;
    }
    yield* this.run(withProjectInstructions(buildAnswerMessages(input), input.project_context), input, signal);
  }
  async *authorExplainer({ question, project_context } = {}, signal) { yield* this.run(withProjectInstructions(buildExplainerMessages({ question }), project_context, { includeFiles: true }), { question, project_context }, signal); }
  async *authorDocument(source, signal) { yield* this.run(buildAuthorMessages(source), source, signal); }
  async *run(messages, context, signal) {
    const formatted = typeof messages === "string" ? messages : formatMessages(messages);
    const prompt = ["You are running inside DeepSeek Harness through RabbitHole.", "Project files are read-only. Do not create, edit, delete, rename, or move files.", "Preserve the requested RabbitHole answer format.", "", formatted].join("\n");
    this.emit("user/message", { text: String(context?.question || context?.selected_text || prompt) });
    this.emit("run/status", { status: "started", kind: this.kind });
    this.emit("request/context", { project_id: this.projectId, has_project_context: !!context?.project_context });
    for (const skill of context?.project_context?.skills || []) this.emit("skill/activated", { skill: skill.name || skill.id, source: "project context" });
    let response;
    try {
      response = await fetch(this.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", "X-DailyDesk-Request": "harness" }, body: JSON.stringify({ mode: this.mode, profile: this.mode, provider: this.providerName, model: this.model, reasoning_effort: this.reasoningEffort, session_id: this.sessionId, run_id: this.runId, node_id: this.nodeId, project_id: this.projectId, prompt, question: context?.question || context?.selected_text || '', review: context?.knowledge_search ? false : Boolean(context?.project_context), knowledge_search: context?.knowledge_search === true, project_context: context?.knowledge_search ? null : context?.project_context }), signal });
    } catch (error) {
      this.emit("run/error", { message: error?.message || String(error) });
      throw error;
    }
    if (!response.ok) { const detail = await response.json().catch(() => ({})); const error = new ProviderError(detail.error?.message || detail.error || `DeepSeek Harness returned HTTP ${response.status}.`, { status: response.status, code: "harness_failed" }); this.emit("run/error", { message: error.message }); throw error; }
    if (!response.body) { const error = new Error("DeepSeek Harness did not return an event stream."); this.emit("run/error", { message: error.message }); throw error; }
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
    let completed = false;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/); buffer = frames.pop() || "";
        for (const frame of frames) { const event = parseFrame(frame); if (event) { if (event.type === "run/completed") completed = true; yield* this.handle(event); } }
      }
      buffer += decoder.decode();
      if (buffer) { const event = parseFrame(buffer); if (event) { if (event.type === "run/completed") completed = true; yield* this.handle(event); } }
      if (!completed) throw new ProviderError("DSH 连接中断，未收到完成记录。已收到的内容已保留。", { code: "stream_interrupted" });
    } catch (error) {
      this.emit("run/error", { status: "failed", message: error.message });
      throw error;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  *handle(event) {
    const normalized = createHarnessEvent(event.type, { ...event, at: event.at || new Date().toISOString(), session_id: this.sessionId || event.session_id, run_id: this.runId || event.run_id, node_id: this.nodeId || event.node_id, project_id: this.projectId || event.project_id });
    this.onEvent?.(normalized);
    if (event.type === "run/error") throw new ProviderError(event.message || event.error?.message || "DSH 执行失败。", { code: event.code || "harness_failed" });
    if (event.type === "assistant/text/replace") yield { type: "text.replace", delta: String(event.text ?? "") };
    if ((event.type === "assistant/message" || event.type === "assistant/text/delta" || event.type === "text") && (event.delta || event.text)) yield { type: "text", delta: event.delta || event.text };
  }
  emit(type, payload) {
    this.onEvent?.(createHarnessEvent(type, payload, { sessionId: this.sessionId, runId: this.runId, nodeId: this.nodeId, projectId: this.projectId }));
  }
}

function parseFrame(frame) {
  const line = String(frame).split(/\r?\n/).find(value => value.startsWith("data:"));
  if (!line) return null;
  try { return JSON.parse(line.slice(5).trim()); } catch { return null; }
}
function formatMessages(messages) {
  return (messages || []).map(message => `${String(message.role || "user").toUpperCase()}:\n${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`).join("\n\n");
}

export function createDshProvider(settings, options = {}) {
  return new DshBrowserProvider({ mode: window.__dshpluginStatus?.generation ? 'hosted' : "auto", provider: settings?.dsh_provider || "deepseek-official", model: settings?.model || "deepseek-flash", reasoningEffort: settings?.reasoning || "", ...options });
}
