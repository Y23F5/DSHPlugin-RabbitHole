import { buildAnswerMessages } from "../../core/prompts/answering-v1.js";
import { buildAuthorMessages } from "../../core/prompts/authoring-v1.js";
import { buildExplainerMessages } from "../../core/prompts/explainer-v1.js";
import { buildTranscribeMessages } from "../../core/prompts/transcribe-v1.js";
import { ProviderError, normalizeProviderError } from "./errors.js";
import { addressSpaceHint, normalizeApiBase, headersForProtocol } from "./model-endpoint.js";
import { adaptBranchGeneration, adaptTextGeneration } from "./generation-events.js";
import { providerFor } from "./provider-registry.js";
import { withProjectInstructions } from './project-prompt.js';

export function createProvider(settings, apiKey) {
  const preset = providerFor(settings?.preset);
  const model = settings?.model || preset.model;
  const provider = new OpenAICompatibleProvider({
    baseUrl: (preset.id === "custom_endpoint" && settings?.resolved_base_url) || settings?.base_url || preset.base_url,
    discovered: preset.id === "custom_endpoint" && !!settings?.resolved_base_url,
    protocol: preset.id === "custom_endpoint" ? settings?.endpoint_protocol || "openai" : "openai",
    apiKey,
    model,
    transcribeModel: settings?.transcribe_model || preset.transcribe_model || model,
    reasoningEffort: settings?.reasoning || "",
    toolUse: preset.id === "custom_endpoint" && (settings?.endpoint_protocol || "openai") === "openai",
  });
  provider.provenance = { provider: preset.id === 'subscriptions' ? settings.agent || model.split('/')[0] : preset.id, model, reasoning: settings?.reasoning || '' };
  return provider;
}

export class OpenAICompatibleProvider {
  /** @param {any} [options] */
  constructor({ baseUrl, apiKey, model, transcribeModel, discovered = false, protocol = "openai", reasoningEffort = "", extraHeaders = {}, title = "Rabbithole", toolUse = false } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (!discovered && new URL(this.baseUrl).pathname === "/" && !/\/(?:models|chat\/completions|responses|messages)(?:\?|$)/.test(baseUrl)) {
      const url = new URL(this.baseUrl);
      url.pathname = protocol === "gemini" ? "/v1beta" : "/v1";
      this.baseUrl = url.toString();
    }
    this.protocol = protocol;
    if (!discovered && protocol !== "openai" && !/\/v\d+(?:beta\d*)?$/.test(new URL(this.baseUrl).pathname.replace(/\/$/, "")) && !/\/(?:models|messages)(?:\?|$)/.test(baseUrl)) {
      const url = new URL(this.baseUrl);
      url.pathname = `${url.pathname.replace(/\/$/, "")}/${protocol === "gemini" ? "v1beta" : "v1"}`;
      this.baseUrl = url.toString();
    }
    this.apiKey = apiKey || "";
    this.model = model || "anthropic/claude-sonnet-5";
    this.transcribeModel = transcribeModel || this.model;
    this.reasoningEffort = reasoningEffort || "";
    this.extraHeaders = extraHeaders || {};
    this.title = title;
    this.toolUse = toolUse;
    this.onHarnessEvent = null;
    this.projectId = "";
    this.provenance = { provider: 'openai-compatible', model: this.model, reasoning: this.reasoningEffort };
  }

  tuning() {
    return this.reasoningEffort ? { reasoning_effort: this.reasoningEffort } : {};
  }

  learningMetadata(kind, context) {
    if (context?.project_context?.learning_enabled === false) return {};
    // Only the local subscription bridge receives the learning adapter protocol.
    const url = new URL(this.baseUrl);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || !/^(codex|claude)\//.test(this.model)) return {};
    return { dailydesk_learning: {
      kind, hole_id: context?.hole_id, node_id: context?.node_id,
      parent_id: context?.parent_id, question: context?.question || context?.selected_text || "请解释所选内容。",
      selected_text: context?.selected_text || "",
    } };
  }

  projectMetadata() {
    const url = new URL(this.baseUrl);
    return ["127.0.0.1", "localhost"].includes(url.hostname) && /^(codex|claude)\//.test(this.model) ? { project_id: this.projectId } : {};
  }

  async *authorDocument(source, signal) {
    const body = {
      model: this.model,
      messages: buildAuthorMessages(source),
      stream: true,
      temperature: 0.2,
      ...this.tuning(),
    };
    yield* adaptTextGeneration(streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl),
      apiKey: this.apiKey,
      body,
      signal,
      extraHeaders: this.extraHeaders,
      title: this.title,
      protocol: this.protocol,
      onHarnessEvent: (type, payload) => this.onHarnessEvent?.(type, payload),
    }));
  }

  /** @param {{question?: string, learning?: any}} [input] @param {AbortSignal} [signal] */
  async *authorExplainer({ question, learning, project_context } = {}, signal) {
    const body = {
      model: this.model,
      messages: withProjectInstructions(buildExplainerMessages({ question }), project_context, { includeFiles: true }),
      ...this.learningMetadata("explainer", { ...learning, question, project_context }),
      ...this.projectMetadata(),
      stream: true,
      temperature: 0.35,
      ...this.tuning(),
    };
    const stream = this.toolUse ? streamProjectTools({ provider: this, messages: body.messages, body, context: { question, project_context }, signal }) : streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl),
      apiKey: this.apiKey,
      body,
      signal,
      extraHeaders: this.extraHeaders,
      title: this.title,
      protocol: this.protocol,
      onHarnessEvent: (type, payload) => this.onHarnessEvent?.(type, payload),
    });
    yield* adaptTextGeneration(stream);
  }

  async *answerBranch(context, signal) {
    const body = {
      model: this.model,
      messages: withProjectInstructions(buildAnswerMessages(context), context?.project_context),
      ...this.learningMetadata("branch", context),
      ...this.projectMetadata(),
      stream: true,
      temperature: 0.4,
      ...this.tuning(),
    };
    const stream = this.toolUse ? streamProjectTools({ provider: this, messages: body.messages, body, context, signal }) : streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl),
      apiKey: this.apiKey,
      body,
      signal,
      extraHeaders: this.extraHeaders,
      title: this.title,
      protocol: this.protocol,
      onHarnessEvent: (type, payload) => this.onHarnessEvent?.(type, payload),
    });
    yield* adaptBranchGeneration(stream, { fallbackTitle: context?.fallbackTitle });
  }

  async *transcribePages(input, signal) {
    yield* adaptTextGeneration(streamOpenAICompatible({
      url: chatCompletionsUrl(this.baseUrl), apiKey: this.apiKey,
      body: { model: this.transcribeModel, messages: buildTranscribeMessages(input), stream: true, temperature: 0.1, ...this.tuning() },
      signal, extraHeaders: this.extraHeaders, title: this.title,
      protocol: this.protocol,
      onHarnessEvent: (type, payload) => this.onHarnessEvent?.(type, payload),
    }));
  }
}

/**
 * @param {{
 *   url: string,
 *   apiKey?: string,
 *   body: any,
 *   signal?: AbortSignal,
 *   extraHeaders?: Record<string, string>,
 *   title?: string,
 *   protocol?: string,
 *   onHarnessEvent?: (type: string, payload: any) => void,
 * }} input
 */
export async function* streamOpenAICompatible({ url, apiKey, body, signal, extraHeaders = {}, title = "Rabbithole", protocol = "openai", onHarnessEvent = () => {} }) {
  if (protocol !== "openai") {
    yield* streamNativeCompatible({ url, apiKey, body, signal, extraHeaders, protocol });
    return;
  }
  let response;
  try {
    /** @type {Record<string, string>} */
    const headers = {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      ...extraHeaders,
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    if (url.startsWith("https://openrouter.ai/")) {
      headers["HTTP-Referer"] = globalThis.location?.origin || "https://rabbithole.ing";
      headers["X-Title"] = title;
    }
    // Discovery reached this endpoint the same way; generation has to declare the same
    // address space or the model list would load and every answer would fail.
    response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal, ...addressSpaceHint(url) });
  } catch (err) {
    throw normalizeProviderError(err);
  }
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new ProviderError("The provider did not return a stream.", { code: "no_stream" });

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() || "";
      for (const event of events) {
        const text = parseOpenAISseEvent(event, onHarnessEvent);
        if (text) yield text;
      }
    }
    if (buffer) {
      const text = parseOpenAISseEvent(buffer, onHarnessEvent);
      if (text) yield text;
    }
  } catch (err) {
    throw normalizeProviderError(err);
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

const PROJECT_TOOLS = Object.freeze([
  { type: "function", function: { name: "project_list", description: "List read-only files and folders in an authorized RabbitHole project.", parameters: { type: "object", properties: { project_id: { type: "string" } }, required: ["project_id"] } } },
  { type: "function", function: { name: "project_tree", description: "Browse a read-only project directory.", parameters: { type: "object", properties: { project_id: { type: "string" }, path: { type: "string" }, depth: { type: "integer" } }, required: ["project_id"] } } },
  { type: "function", function: { name: "project_search", description: "Search text and file names in an authorized read-only project.", parameters: { type: "object", properties: { project_id: { type: "string" }, query: { type: "string" }, limit: { type: "integer" } }, required: ["project_id", "query"] } } },
  { type: "function", function: { name: "project_read", description: "Read a text file from an authorized read-only project.", parameters: { type: "object", properties: { project_id: { type: "string" }, path: { type: "string" }, root: { type: "integer" } }, required: ["project_id", "path"] } } },
]);

async function* streamProjectTools({ provider, messages, body, context, signal }) {
  const projects = Array.isArray(context?.project_context?.projects) ? context.project_context.projects : [];
  const allowed = new Set(projects.map(project => String(project.id)));
  if (!projects.length) { yield* streamOpenAICompatible({ url: chatCompletionsUrl(provider.baseUrl), apiKey: provider.apiKey, body, signal, extraHeaders: provider.extraHeaders, title: provider.title, protocol: provider.protocol, onHarnessEvent: (type, payload) => provider.onHarnessEvent?.(type, payload) }); return; }
  const history = messages.map(message => ({ ...message }));
  for (let turn = 0; turn < 6; turn += 1) {
    let response;
    try {
      const url = chatCompletionsUrl(provider.baseUrl);
      response = await fetch(url, { method: "POST", headers: openAIHeaders(provider), body: JSON.stringify({ ...body, messages: history, stream: false, tools: PROJECT_TOOLS, tool_choice: "auto" }), signal, ...addressSpaceHint(url) });
      if (!response.ok) throw await responseError(response);
      response = await response.json();
    } catch (error) {
      if (error?.status === 400 || error?.status === 404 || error?.code === "invalid_request_error") {
        yield* streamOpenAICompatible({ url: chatCompletionsUrl(provider.baseUrl), apiKey: provider.apiKey, body: { ...body, messages: history, stream: true }, signal, extraHeaders: provider.extraHeaders, title: provider.title, protocol: provider.protocol, onHarnessEvent: (type, payload) => provider.onHarnessEvent?.(type, payload) });
        return;
      }
      throw error;
    }
    const message = response?.choices?.[0]?.message || {};
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (!calls.length) { if (message.content) yield String(message.content); return; }
    history.push({ role: "assistant", content: message.content || null, tool_calls: calls });
    for (const call of calls) {
      const name = call.function?.name || call.name || "";
      let args = {};
      try { args = JSON.parse(call.function?.arguments || call.arguments || "{}"); } catch { args = {}; }
      provider.onHarnessEvent?.("tool/call", { name, arguments: args, call_id: call.id || "" });
      let result;
      try { result = await executeProjectTool(name, args, allowed); }
      catch (error) { result = { error: error.message || String(error) }; }
      provider.onHarnessEvent?.("tool/result", { name, call_id: call.id || "", result });
      history.push({ role: "tool", tool_call_id: call.id || name, content: JSON.stringify(result).slice(0, 24000) });
    }
  }
  yield "The project tool loop reached its safety limit. Please narrow the question.";
}

function openAIHeaders(provider) {
  const headers = { "Content-Type": "application/json", Accept: "application/json", ...provider.extraHeaders };
  if (provider.apiKey) headers.Authorization = `Bearer ${provider.apiKey}`;
  if (provider.baseUrl.startsWith("https://openrouter.ai/")) { headers["HTTP-Referer"] = globalThis.location?.origin || "https://rabbithole.ing"; headers["X-Title"] = provider.title; }
  return headers;
}

async function executeProjectTool(name, args, allowed) {
  const projectId = String(args.project_id || "");
  if (!allowed.has(projectId)) throw new Error("The project is not authorized for this RabbitHole.");
  const query = name === "project_list" ? `projects/${encodeURIComponent(projectId)}/tree?depth=2&limit=300`
    : name === "project_tree" ? `projects/${encodeURIComponent(projectId)}/tree?depth=${Math.max(0, Math.min(8, Number(args.depth) || 3))}&limit=500&path=${encodeURIComponent(String(args.path || ""))}`
      : name === "project_search" ? `projects/${encodeURIComponent(projectId)}/search?q=${encodeURIComponent(String(args.query || ""))}&limit=${Math.max(1, Math.min(100, Number(args.limit) || 30))}`
        : name === "project_read" ? `projects/${encodeURIComponent(projectId)}/read?root=${Math.max(0, Number(args.root) || 0)}&path=${encodeURIComponent(String(args.path || ""))}` : "";
  if (!query) throw new Error(`Unknown project tool: ${name}`);
  const response = await fetch(`/api/library/${query}`, { headers: { "X-DailyDesk-Request": "library" }, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Project tool failed (${response.status}).`);
  return data;
}

export function parseOpenAISseEvent(eventText, onHarnessEvent = () => {}) {
  const lines = String(eventText || "").split(/\r?\n/);
  let out = "";
  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (!data || data === "[DONE]") continue;
    let json;
    try { json = JSON.parse(data); } catch { continue; }
    if (json.harness_event && typeof json.harness_event.type === "string") onHarnessEvent(json.harness_event.type, json.harness_event);
    if (json.error) throw new ProviderError(json.error.message || "The provider returned an error.", { code: json.error.code || "provider_error" });
    out += json.choices?.[0]?.delta?.content || json.choices?.[0]?.message?.content || "";
  }
  return out;
}

async function responseError(response) {
  let detail = "";
  let providerCode = "";
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        detail = json.error?.message || json.message || "";
        providerCode = json.error?.code || json.code || "";
      } catch {
        detail = text.slice(0, 180);
      }
    }
  } catch {}
  const status = response.status;
  const prefix = status === 401 ? "Bad or missing API key"
    : status === 429 ? "Rate limited by the provider"
      : `Provider returned HTTP ${status}`;
  const bridgeFailure = [
    "unauthorized",
    "agent_signed_out",
    "agent_missing",
    "model_unknown",
    "model_no_images",
    "payload_too_large",
    "turn_failed",
  ].includes(providerCode);
  return new ProviderError(bridgeFailure && detail ? detail : detail ? `${prefix}: ${detail}` : prefix, {
    status,
    code: providerCode || String(status),
    retryable: status !== 401 && status !== 403,
  });
}

function normalizeBaseUrl(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!value) throw new ProviderError("A provider base URL is required.", { code: "missing_base_url", retryable: false });
  return normalizeApiBase(value);
}

function chatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/chat/completions`;
  return url.toString();
}

function nativeContent(content, protocol) {
  const parts = typeof content === "string" ? [{ type: "text", text: content }] : content || [];
  return parts.map((part) => {
    if (part.type === "text") return protocol === "gemini" ? { text: part.text } : part;
    if (part.type !== "image_url") throw new ProviderError("Unsupported content type for this API protocol.");
    const source = String(part.image_url?.url || "");
    const data = /^data:([^;,]+);base64,(.+)$/s.exec(source);
    if (protocol === "anthropic") return { type: "image", source: data ? { type: "base64", media_type: data[1], data: data[2] } : { type: "url", url: source } };
    if (!data) throw new ProviderError("Gemini image input requires an embedded image.");
    return { inlineData: { mimeType: data[1], data: data[2] } };
  });
}

async function* streamNativeCompatible({ url, apiKey, body, signal, extraHeaders, protocol }) {
  const endpoint = new URL(normalizeApiBase(url));
  let basePath = endpoint.pathname.replace(/\/$/, "");
  const system = body.messages.filter((message) => message.role === "system").map((message) => String(message.content)).join("\n\n");
  const messages = body.messages.filter((message) => message.role !== "system");
  let requestBody;
  if (protocol === "anthropic") {
    endpoint.pathname = `${basePath}/messages`;
    requestBody = { model: body.model, system, messages: messages.map((message) => ({ role: message.role, content: nativeContent(message.content, protocol) })), stream: true, max_tokens: 8192, temperature: body.temperature };
  } else if (protocol === "gemini") {
    endpoint.pathname = `${basePath}/models/${encodeURIComponent(body.model.replace(/^models\//, ""))}:streamGenerateContent`;
    endpoint.searchParams.set("alt", "sse");
    requestBody = { systemInstruction: { parts: [{ text: system }] }, contents: messages.map((message) => ({ role: message.role === "assistant" ? "model" : "user", parts: nativeContent(message.content, protocol) })), generationConfig: { temperature: body.temperature } };
  } else throw new ProviderError("Unsupported API protocol.");
  const response = await fetch(endpoint, { method: "POST", redirect: "error", headers: { ...headersForProtocol(apiKey, protocol, extraHeaders), Accept: "text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify(requestBody), signal, ...addressSpaceHint(endpoint) });
  if (!response.ok) throw await responseError(response);
  if (!response.body) throw new ProviderError("The provider did not return a stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parse = (event) => {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    if (!data || data === "[DONE]") return "";
    const payload = JSON.parse(data);
    if (payload.error) throw new ProviderError(payload.error.message || "The provider returned an error.");
    if (protocol === "anthropic") return payload.type === "content_block_delta" && payload.delta?.type === "text_delta" ? payload.delta.text : "";
    return (payload.candidates?.[0]?.content?.parts || []).filter((part) => !part.thought).map((part) => part.text || "").join("");
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || "";
      for (const event of events) { const text = parse(event); if (text) yield text; }
    }
    buffer += decoder.decode();
    if (buffer) { const text = parse(buffer); if (text) yield text; }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
