import { modelDescriptor } from "./model-descriptor.js";

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_ERROR_BODY = 240;
const KNOWN_COMPAT_SUFFIXES = [
  "/api/claudecode", "/api/anthropic", "/apps/anthropic", "/api/gemini",
  "/api/coding", "/claudecode", "/anthropic", "/step_plan", "/coding", "/claude",
];

export function isHttpUrl(value) {
  try {
    const { protocol } = new URL(String(value || "").trim());
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeEndpointUrl(value) {
  const raw = String(value || "").trim();
  if (!isHttpUrl(raw)) {
    throw Object.assign(new Error("Enter a full URL, like https://api.example.com/v1."), { code: "invalid_url" });
  }
  const url = new URL(raw);
  if (url.username || url.password) throw Object.assign(new Error("Put credentials in the API key field."), { code: "invalid_url" });
  url.hash = "";
  url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
  return url.toString().replace(/\/$/, "");
}

function hasVersionSegment(path) {
  const segment = path.split("/").filter(Boolean).at(-1) || "";
  return /^v\d+(?:beta\d*)?$/i.test(segment);
}

function appendPath(base, suffix) {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
  return url.toString();
}

function stripKnownSuffix(base) {
  const url = new URL(base);
  const match = KNOWN_COMPAT_SUFFIXES.find((suffix) => url.pathname.toLowerCase().endsWith(suffix));
  if (!match) return "";
  url.pathname = url.pathname.slice(0, -match.length) || "/";
  return url.toString();
}

export function normalizeApiBase(baseUrl) {
  const url = new URL(normalizeEndpointUrl(baseUrl));
  url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages|models(?:\/[^/]+:(?:streamGenerateContent|generateContent))?)\/?$/i, "");
  return url.toString().replace(/\/$/, "");
}

export function buildModelEndpointCandidates(baseUrl, { protocol = "openai", isFullUrl = false, modelsUrl = "" } = {}) {
  if (!["openai", "anthropic", "gemini", "auto"].includes(protocol)) throw new Error("Unsupported API protocol.");
  const original = normalizeEndpointUrl(modelsUrl || baseUrl);
  const base = modelsUrl ? original : normalizeApiBase(original);
  if (modelsUrl) return [{ url: base, protocol: protocol === "auto" ? "openai" : protocol }];
  const candidates = [];
  const add = (url, candidateProtocol = protocol) => {
    if (!candidates.some((entry) => entry.url === url && entry.protocol === candidateProtocol)) candidates.push({ url, protocol: candidateProtocol });
  };
  const url = new URL(base);
  const path = url.pathname;
  const protocolList = [protocol === "auto" ? (/generativelanguage\.googleapis\.com/.test(url.hostname) ? "gemini" : /api\.anthropic\.com/.test(url.hostname) ? "anthropic" : "openai") : protocol];
  const addForProtocol = (candidateProtocol) => {
    const isGemini = candidateProtocol === "gemini";
    const versionPath = isGemini ? "v1beta/models" : "v1/models";
    if (path.endsWith("/models")) add(base, candidateProtocol);
    else if (hasVersionSegment(path)) add(appendPath(base, "models"), candidateProtocol);
    else add(appendPath(base, versionPath), candidateProtocol);
    if (!isGemini) add(appendPath(base, "models"), candidateProtocol);
    const root = stripKnownSuffix(base);
    if (root) {
      add(appendPath(root, isGemini ? "v1beta/models" : "v1/models"), candidateProtocol);
      add(appendPath(root, "models"), candidateProtocol);
    }
  };
  for (const candidateProtocol of protocolList) addForProtocol(candidateProtocol);
  return candidates;
}

export function headersForProtocol(apiKey, protocol, extraHeaders = {}) {
  const headers = { Accept: "application/json", ...extraHeaders };
  if (protocol === "anthropic") headers["anthropic-version"] ||= "2023-06-01";
  if (apiKey) {
    if (protocol === "anthropic") {
      headers["x-api-key"] ||= apiKey;
      headers["anthropic-version"] ||= "2023-06-01";
    } else if (protocol === "gemini") {
      headers["x-goog-api-key"] ||= apiKey;
    } else {
      headers["Authorization"] ||= `Bearer ${apiKey}`;
    }
  }
  return headers;
}

function combineSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason || new DOMException("The request was cancelled.", "AbortError"));
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new DOMException("The request timed out.", "TimeoutError")), timeoutMs);
  return { signal: controller.signal, dispose: () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); } };
}

function errorBody(text, secrets = []) {
  let value = String(text || "");
  for (const secret of secrets.filter(Boolean)) value = value.split(secret).join("[redacted]");
  value = value.replace(/\s+/g, " ").trim();
  return value.length > MAX_ERROR_BODY ? `${value.slice(0, MAX_ERROR_BODY)}…` : value;
}

function parseModelList(json, protocol) {
  const entries = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : json?.data === null ? [] : null;
  if (!entries) throw Object.assign(new Error("Model endpoint returned an invalid model list."), { code: "invalid_response" });
  const models = entries.map((model) => {
    if (protocol === "gemini" && Array.isArray(model?.supportedGenerationMethods) && !model.supportedGenerationMethods.includes("generateContent")) return null;
    const rawId = model?.id || model?.slug || model?.name;
    if (!rawId) return null;
    const id = String(rawId).replace(/^models\//, "");
    return modelDescriptor({
      id,
      name: String(model?.display_name || model?.displayName || model?.name || id).replace(/^models\//, ""),
      vision: typeof model?.vision === "boolean" ? model.vision : undefined,
      reasoning: model?.reasoning,
    });
  }).filter((model) => model?.id && !/embed/i.test(`${model.id} ${model.name}`));
  return [...new Map(models.map((model) => [model.id, model])).values()];
}

function makeError(message, fields = {}) {
  return Object.assign(new Error(message), fields);
}

/** @param {string} baseUrl @param {{apiKey?: string, signal?: AbortSignal, protocol?: string, modelsUrl?: string, timeoutMs?: number, extraHeaders?: Record<string,string>, isFullUrl?: boolean, onResolved?: (base: string) => void}} [options] */
export async function fetchOpenAICompatibleModels(baseUrl, {
  apiKey = "", signal, protocol = "openai", modelsUrl = "", timeoutMs = DEFAULT_TIMEOUT_MS, extraHeaders = {}, isFullUrl = false, onResolved = () => {},
} = {}) {
  const candidates = buildModelEndpointCandidates(baseUrl, { protocol, isFullUrl, modelsUrl });
  let lastError = null;
  let lastNotFound = null;
  for (const candidate of candidates) {
    const combined = combineSignals(signal, timeoutMs);
    try {
      const response = await fetch(candidate.url, {
        headers: headersForProtocol(apiKey, candidate.protocol, extraHeaders),
        signal: combined.signal,
        redirect: "error",
        ...addressSpaceHint(candidate.url),
      });
      const text = await response.text();
      if (response.ok) {
        let json;
        try { json = JSON.parse(text); } catch { throw makeError("Model endpoint returned HTML or invalid JSON.", { code: "invalid_response", status: response.status, endpoint: candidate.url }); }
        const models = parseModelList(json, candidate.protocol);
        const seen = new Set();
        for (let page = 0; json.nextPageToken || json.has_more; page += 1) {
          const token = candidate.protocol === "gemini" ? json.nextPageToken : json.last_id;
          if (!token || seen.has(token) || page >= 99) throw makeError("Model pagination did not finish. Enter a model ID manually.", { code: "invalid_response" });
          seen.add(token);
          const next = new URL(candidate.url);
          next.searchParams.set(candidate.protocol === "gemini" ? "pageToken" : "after_id", token);
          const response = await fetch(next, { headers: headersForProtocol(apiKey, candidate.protocol, extraHeaders), signal: combined.signal, redirect: "error", ...addressSpaceHint(next) });
          if (!response.ok) throw makeError(`Model page returned HTTP ${response.status}.`, { status: response.status });
          const pageText = await response.text();
          try { json = JSON.parse(pageText); } catch { throw makeError("Model page returned invalid JSON.", { code: "invalid_response" }); }
          models.push(...parseModelList(json, candidate.protocol));
        }
        onResolved(normalizeApiBase(candidate.url));
        return [...new Map(models.map((model) => [model.id, model])).values()];
      }
      const html = /<\s*(?:!doctype|html|head|body)/i.test(text);
      const detail = html ? "The server returned an HTML page or WAF challenge." : errorBody(text, [apiKey, ...Object.values(extraHeaders)]);
      const error = makeError(detail ? `Endpoint returned HTTP ${response.status}: ${detail}` : `Endpoint returned HTTP ${response.status}.`, {
        status: response.status, endpoint: candidate.url, protocol: candidate.protocol,
        code: response.status === 429 ? "rate_limited" : response.status === 401 || response.status === 403 ? "auth_failed" : String(response.status),
        retryable: response.status >= 500 || response.status === 429,
        html, retryAfter: response.headers.get("retry-after"),
      });
      if (response.status === 404 || response.status === 405) { lastNotFound = error; continue; }
      throw error;
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") {
        if (signal?.aborted) throw error;
        throw makeError("Model request timed out.", { code: "timeout", retryable: true, endpoint: candidate.url });
      }
      if (error?.status === 404 || error?.status === 405) { lastNotFound = error; continue; }
      lastError = error;
      if (error?.code === "invalid_response" && candidates.length > 1) continue;
      throw error;
    } finally {
      combined.dispose();
    }
  }
  if (lastError) throw lastError;
  if (lastNotFound) throw makeError("No supported model-list endpoint was found. You can enter a model ID manually.", {
    code: "endpoint_not_found", status: lastNotFound.status, endpoint: lastNotFound.endpoint, attempts: candidates.map((entry) => entry.url),
  });
  throw lastError || makeError("No model-list endpoint was available.", { code: "endpoint_not_found" });
}

export function addressSpaceHint(url) {
  const space = addressSpaceOf(url);
  return space ? { targetAddressSpace: space } : {};
}

export function addressSpaceOf(url) {
  let hostname;
  try { hostname = new URL(String(url || "")).hostname.toLowerCase(); } catch { return ""; }
  if (hostname === "localhost") return "loopback";
  if (hostname.startsWith("[")) return ipv6AddressSpace(hostname.slice(1, -1));
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname)?.slice(1).map(Number);
  if (octets) {
    if (octets.some((octet) => octet > 255)) return "";
    const [a, b] = octets;
    if (a === 127) return "loopback";
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return "local";
    return "";
  }
  return hostname.endsWith(".local") ? "local" : "";
}

function ipv6AddressSpace(address) {
  if (address === "::1") return "loopback";
  if (/^f[cd]/.test(address)) return "local";
  return /^fe[89ab]/.test(address) ? "local" : "";
}
