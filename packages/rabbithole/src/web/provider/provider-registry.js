export const PROVIDERS = Object.freeze({
  openrouter: Object.freeze({
    id: "openrouter",
    label: "OpenRouter",
    recommended: true,
    model_source: "catalog",
    base_url: "https://openrouter.ai/api/v1",
    kind: "openai-compatible",
    requires_key: true,
    model: "anthropic/claude-sonnet-5",
    transcribe_model: "google/gemini-2.5-flash",
  }),
  subscriptions: Object.freeze({
    id: "subscriptions",
    label: "CC/Codex",
    model_source: "bridge",
    base_url: "http://127.0.0.1:45233/v1",
    kind: "openai-compatible",
    requires_key: false,
    model: "",
    transcribe_model: "",
  }),
  local: Object.freeze({
    id: "local",
    label: "Local",
    model_source: "custom",
    base_url: "http://localhost:11434/v1",
    kind: "openai-compatible",
    requires_key: false,
    model: "llama3.2",
    transcribe_model: "llama3.2",
  }),
  custom_endpoint: Object.freeze({
    id: "custom_endpoint",
    label: "Custom",
    model_source: "custom",
    base_url: "",
    kind: "openai-compatible",
    requires_key: false,
    allows_key: true,
    requires_base_url: true,
    key_label: "API key",
    model: "",
    transcribe_model: "",
  }),
  dsh_custom: Object.freeze({
    id: "dsh_custom",
    label: "当前 DSH 宿主",
    model_source: "dsh",
    base_url: "/api/harness/run",
    kind: "dsh",
    requires_key: false,
    model: "deepseek-flash",
    transcribe_model: "",
    dsh_mode: "auto",
  }),
});

export function providerFor(id) {
  if (["dsh_sdk", "dsh_acp_live", "dsh_sdk_minimal", "dsh_gateway"].includes(id)) return PROVIDERS.dsh_custom;
  return PROVIDERS[id] || PROVIDERS.openrouter;
}

/** @returns {Record<string, any>} */
export function defaultProviderSettings() {
  const provider = PROVIDERS.dsh_custom;
  return {
    preset: provider.id,
    base_url: provider.base_url,
    model: provider.model,
    transcribe_model: provider.transcribe_model,
    reasoning: "",
    agent: "",
    agents: {},
    fetch_proxy_url: "",
    session_only: false,
    providers: providerDefaults(),
  };
}

/** @param {string} id @param {Record<string, any>} [current] @returns {Record<string, any>} */
export function settingsForProvider(id, current = {}) {
  const provider = providerFor(id);
  const currentProvider = providerFor(current.preset);
  const providers = normalizeProviderSettings(current.providers);
  providers[currentProvider.id] = settingsSlot(currentProvider, current);
  const restored = settingsSlot(provider, providers[provider.id]);
  return {
    ...current,
    agent: "",
    agents: {},
    preset: provider.id,
    ...restored,
    providers,
  };
}

function providerDefaults() {
  return Object.fromEntries(Object.values(PROVIDERS).map((provider) => [provider.id, settingsSlot(provider)]));
}

/** @param {any} value @param {Record<string, any>} [fallbacks] @returns {Record<string, any>} */
export function normalizeProviderSettings(value, fallbacks = {}) {
  const providers = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return providers;
  for (const [id, slot] of Object.entries(value)) {
    const provider = PROVIDERS[id];
    if (!provider || !slot || typeof slot !== "object" || Array.isArray(slot)) continue;
    providers[provider.id] = settingsSlot(provider, slot, fallbacks[provider.id]);
  }
  return providers;
}

function stringField(value, fallback, name, defaultValue = "") {
  if (typeof value?.[name] === "string") return value[name];
  if (typeof fallback?.[name] === "string") return fallback[name];
  return defaultValue;
}

function settingsSlot(provider, value = {}, fallback = {}) {
  const configuredModel = stringField(value, fallback, "model", provider.model);
  const configuredDshProvider = stringField(value, fallback, "dsh_provider", "deepseek-official");
  const legacyDshDefaults = provider.model_source === "dsh"
    && configuredDshProvider === "deepseek";
  const slot = {
    base_url: stringField(value, fallback, "base_url", provider.base_url),
    model: legacyDshDefaults && configuredModel === "deepseek-chat" ? "deepseek-flash" : configuredModel,
    transcribe_model: stringField(value, fallback, "transcribe_model", provider.transcribe_model),
    reasoning: stringField(value, fallback, "reasoning"),
    endpoint_protocol: stringField(value, fallback, "endpoint_protocol", "openai"),
    resolved_base_url: stringField(value, fallback, "resolved_base_url"),
    dsh_mode: stringField(value, fallback, "dsh_mode", provider.dsh_mode || ""),
    dsh_provider: legacyDshDefaults ? "deepseek-official" : configuredDshProvider,
  };
  if (provider.id !== "subscriptions") return slot;
  return {
    ...slot,
    token: stringField(value, fallback, "token"),
    agent: value.agent === "claude" || value.agent === "codex"
      ? value.agent
      : fallback.agent === "claude" || fallback.agent === "codex"
        ? fallback.agent
        : "",
    agents: normalizeSubscriptionAgents(value.agents, fallback.agents),
  };
}

function normalizeSubscriptionAgents(value, fallback = {}) {
  const agents = {};
  for (const id of ["claude", "codex"]) {
    const entry = value && typeof value === "object" && !Array.isArray(value) ? value[id] : null;
    const fallbackEntry = fallback && typeof fallback === "object" && !Array.isArray(fallback) ? fallback[id] : null;
    if ((!entry || typeof entry !== "object" || Array.isArray(entry))
      && (!fallbackEntry || typeof fallbackEntry !== "object" || Array.isArray(fallbackEntry))) continue;
    agents[id] = {
      model: stringField(entry, fallbackEntry, "model"),
      transcribe_model: stringField(entry, fallbackEntry, "transcribe_model"),
      reasoning: stringField(entry, fallbackEntry, "reasoning"),
    };
  }
  return agents;
}
