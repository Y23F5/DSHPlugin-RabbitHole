import { createHarnessEvent } from "./protocol.js";

/**
 * Small transport for a future local DeepSeek Harness host.
 *
 * DSH is still a developer preview, so the browser only depends on this
 * narrow JSON-RPC/SSE boundary. It never imports DSH's private packages.
 */
export class HarnessJsonRpcClient {
  constructor({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = 45000, headers = {} } = {}) {
    this.endpoint = String(endpoint || "").replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.headers = headers;
    if (!this.endpoint) throw new TypeError("Harness endpoint is required");
  }

  async request(method, params = {}, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const relay = () => controller.abort();
    signal?.addEventListener("abort", relay, { once: true });
    try {
      const response = await this.fetchImpl(`${this.endpoint}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...this.headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, method, params }),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.error) {
        const message = body.error?.message || `Harness returned HTTP ${response.status}`;
        throw new Error(message);
      }
      return body.result ?? body;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    }
  }

  event(type, payload, identity) {
    return createHarnessEvent(type, payload, identity);
  }
}
