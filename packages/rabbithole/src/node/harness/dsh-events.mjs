const states = new WeakMap();
const contentText = content => typeof content === "string" ? content : (content || []).filter(block => block.type === "text").map(block => block.text || "").join("");

export function mapDshEvents(raw, identity = {}, calls = new Map()) {
  let state = states.get(calls);
  if (!state) { state = { committed: "", partial: "", live: false, attempt: "", blocks: new Map() }; states.set(calls, state); }
  const type = raw?.type || "";
  const data = raw?.data || raw || {};
  const at = data.at || raw.at || raw.timestamp || new Date(raw.time || Date.now()).toISOString();
  const event = (eventType, value = {}) => ({ ...identity, type: eventType, at, ...value });
  if (type === "rabbithole/stream") {
    const chunk = data.chunk || {};
    state.live = true;
    state.attempt = data.attempt_id;
    if (chunk.type === "attempt-start") { state.partial = ""; state.blocks.clear(); return []; }
    if (chunk.type === "block-start") {
      state.blocks.set(chunk.index, chunk.blockType);
      return chunk.blockType === "reasoning" ? [event("assistant/reasoning/start", { attempt_id: state.attempt, block_id: chunk.index })] : [];
    }
    if (chunk.type === "reasoning-delta") return [event("assistant/reasoning/delta", { delta: chunk.text, attempt_id: state.attempt, block_id: chunk.index })];
    if (chunk.type === "text-delta") { state.partial += chunk.text; return [event("assistant/text/delta", { delta: chunk.text })]; }
    if (chunk.type === "tool-call-delta") return [event("tool/call/delta", { call_id: chunk.id, tool: chunk.name, arguments_delta: chunk.argumentsDelta || "", attempt_id: state.attempt })];
    if (chunk.type === "block-end" && state.blocks.get(chunk.index) === "reasoning") return [event("assistant/reasoning/end", { attempt_id: state.attempt, block_id: chunk.index })];
    if (chunk.type === "attempt-error") return [event("assistant/attempt", { status: "failed", attempt_id: state.attempt, message: chunk.message, text: state.partial }), event("assistant/text/replace", { text: state.committed })];
    return [];
  }
  if (type === "assistant/message") {
    const events = [];
    if (!state.live) {
      const thought = (data.stream || []).map(record => record.type === "reasoning-chunks" ? record.texts.join("") : (record.chunk || record).type === "reasoning-delta" ? (record.chunk || record).text : "").join("");
      const fallback = (data.message?.content || []).filter(block => block.type === "reasoning").map(block => block.text).join("");
      if (thought || fallback) events.push(event("assistant/reasoning", { text: thought || fallback }));
    }
    const text = contentText(data.message?.content);
    state.committed += text;
    events.push(event("assistant/text/replace", { text: state.committed }));
    state.partial = "";
    state.live = false;
    return events;
  }
  if (type === "assistant/attempt") {
    const stream = data.stream || [];
    const chunks = stream.map(record => record.chunk || record);
    const text = stream.map(record => record.type === "text-chunks" ? record.texts.join("") : (record.chunk || record).type === "text-delta" ? (record.chunk || record).text : "").join("");
    const reasoning = stream.map(record => record.type === "reasoning-chunks" ? record.texts.join("") : (record.chunk || record).type === "reasoning-delta" ? (record.chunk || record).text : "").join("");
    const failure = chunks.findLast(chunk => chunk.type === "finish")?.reason?.failure;
    state.partial = "";
    return [event("assistant/attempt", { attempt_id: state.attempt, status: "failed", step: data.step, text, reasoning, message: failure?.message || "这次尝试未提交为正式回答。", tools: stream.filter(record => record.type === "tool-call-chunks").map(record => ({ name: record.name, call_id: record.id, arguments: record.args.join("") })) }), event("assistant/text/replace", { text: state.committed })];
  }
  if (type === "tool/call") {
    calls.set(data.callId, { at: Date.parse(at), tool: data.name });
    return [event("tool/call", { call_id: data.callId, tool: data.name, arguments: data.arguments, status: "running" })];
  }
  if (type === "tool/result") {
    const callId = data.message?.toolCallId || data.callId;
    const call = calls.get(callId);
    const failed = data.message?.isError || !!data.error;
    return [event("tool/result", { call_id: callId, tool: call?.tool, result: contentText(data.message?.content) || data.result || "", error: data.error, status: failed ? "failed" : "completed", ...(call ? { duration_ms: Math.max(0, Date.parse(at) - call.at) } : {}) })];
  }
  if (type.startsWith("llm/retry")) return [event("run/retry", { ...data, status: type === "llm/retry" ? "waiting" : "retrying" })];
  if (type === "turn/end") {
    const reason = data.reason;
    const kind = typeof reason === "string" ? reason : reason?.kind || "";
    if (kind && kind !== "completed") return [event("run/error", { message: reason?.error?.message || reason?.message || reason?.failure?.message || JSON.stringify(reason), status: "failed" })];
    return [event("run/completed", { status: "completed" })];
  }
  if (type.startsWith("subagent/")) return [event(type.endsWith("started") ? "agent/started" : "agent/status", { ...data })];
  if (type.includes("skill")) return [event("skill/activated", data)];
  if (type.includes("error")) return [event("run/error", { message: data.message || JSON.stringify(data) })];
  return [];
}
