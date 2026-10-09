import { renderMarkdownForSurface } from "./renderer.js";

const DEFAULT_LABELS = {
  "user/message": "提问",
  "request/context": "整理项目上下文",
  "assistant/reasoning": "思考过程",
  "assistant/reasoning/start": "开始思考",
  "assistant/reasoning/delta": "思考过程",
  "assistant/reasoning/end": "思考结束",
  "assistant/attempt": "回答尝试",
  "tool/call": "调用工具",
  "tool/call/start": "开始调用工具",
  "tool/call/delta": "工具进行中",
  "tool/call/end": "工具调用结束",
  "tool/result": "工具返回",
  "approval/request": "等待审批",
  "approval/result": "审批结果",
  "skill/activated": "启用 Skill",
  "skill/configured": "Skill 已加入上下文",
  "file/read": "读取文件",
  "file/write": "写入文件",
  "agent/started": "启动 Agent",
  "agent/status": "Agent 状态",
  "run/started": "开始运行",
  "run/completed": "运行完成",
  "run/error": "运行失败",
  "run/status": "运行状态",
  "run/retry": "重试",
  "review/status": "核对进度",
  "review/result": "核对记录",
  "knowledge/status": "网页搜索状态",
};
const STATUS_LABELS = { started: "已开始", running: "进行中", completed: "完成", failed: "失败", waiting: "等待重试", retrying: "重试中", idle: "已结束" };

function text(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function eventTime(event) {
  const value = Date.parse(event?.at || event?.timestamp || "");
  return Number.isFinite(value) ? value : 0;
}

function payloadFor(event) {
  const payload = { ...event };
  ["at", "type", "run_id", "session_id", "node_id", "raw_type"].forEach((key) => delete payload[key]);
  return payload;
}

function mergeValue(previous, value) {
  if (value == null || value === "") return previous || "";
  const incoming = text(value);
  if (!previous) return incoming;
  return previous + incoming;
}

function activityKind(type) {
  const value = String(type || "");
  if (value === "user/message") return "user";
  if (value.includes("reasoning")) return "reasoning";
  if (value.includes("tool/call") || value === "tool/result") return "tool";
  if (value.includes("approval")) return "approval";
  if (value.includes("file/")) return "file";
  if (value.includes("skill/")) return "skill";
  if (value.includes("agent/")) return "agent";
  if (value.includes("attempt") || value.includes("retry")) return "attempt";
  return "status";
}

function formatDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration <= 0) return "";
  if (duration < 1000) return `${Math.round(duration)}ms`;
  return `${(duration / 1000).toFixed(duration >= 10000 ? 0 : 1)}s`;
}

function toolLabel(tool) {
  const value = String(tool || "工具");
  if (value === "web_search" || value === "web-search") return "Web Search";
  if (value === "web_fetch" || value === "web-fetch") return "Web Fetch";
  return value;
}

/**
 * Converts raw harness events into stable, UI-oriented entries. Text deltas
 * are deliberately excluded from the activity stream: the document renderer
 * owns the final answer, while this projection owns the run transcript.
 */
export function projectHarnessRuns(events = []) {
  const runs = new Map();
  for (const source of Array.isArray(events) ? events : []) {
    if (!source || !source.type) continue;
    const event = { ...source };
    const runId = String(event.run_id || "run-local");
    if (!runs.has(runId))
      runs.set(runId, {
        id: runId,
        sessionId: event.session_id || "",
        events: [],
        tools: new Map(),
        approvals: new Map(),
        attempts: new Map(),
        reasonings: [],
        question: "",
        startedAt: eventTime(event),
        status: "",
      });
    const run = runs.get(runId);
    run.startedAt ||= eventTime(event);
    if (event.session_id && event.session_id !== event.canvas_id) run.sessionId = event.session_id;
    if (event.type === "user/message") {
      run.question = mergeValue(run.question, event.text ?? event.delta ?? event.message ?? event.prompt);
      run.events.push({ ...event, kind: "user", label: "提问", detail: run.question });
      continue;
    }
    if (
      event.type === "assistant/message" ||
      event.type === "assistant/text/delta" ||
      event.type === "assistant/text/start" ||
      event.type === "assistant/text/end"
    )
      continue;
    const kind = activityKind(event.type);
    if (kind === "attempt" && event.attempt_id) {
      const existing = run.attempts.get(event.attempt_id);
      const value = { ...event, kind, label: DEFAULT_LABELS[event.type] || "回答尝试", detail: event.message || STATUS_LABELS[event.status] || "" };
      if (existing) Object.assign(existing, value);
      else { run.attempts.set(event.attempt_id, value); run.events.push(value); }
      continue;
    }
    if (kind === "reasoning") {
      const previous = run.reasonings.at(-1);
      const isEnd = event.type.endsWith("/end");
      if (previous && !previous.closed && !event.type.endsWith("/start")) {
        previous.text = mergeValue(previous.text, event.delta ?? event.text ?? event.message);
        previous.closed = isEnd;
        previous.last = event;
      } else {
        const entry = {
          ...event,
          kind,
          label: DEFAULT_LABELS[event.type] || "思考过程",
          text: text(event.delta ?? event.text ?? event.message),
          closed: isEnd,
        };
        run.reasonings.push(entry);
        run.events.push(entry);
      }
      continue;
    }
    if (kind === "tool") {
      const callId = String(event.call_id || event.id || `tool-${run.events.length}`);
      let tool = run.tools.get(callId);
      if (!tool) {
        tool = {
          ...event,
          kind,
          call_id: callId,
          label: "调用工具",
          arguments: "",
          result: "",
          status: "进行中",
          firstAt: eventTime(event),
        };
        run.tools.set(callId, tool);
        run.events.push(tool);
      }
      if (event.tool || event.name) tool.tool = event.tool || event.name;
      if (event.arguments != null || event.input != null)
        tool.arguments = text(event.arguments ?? event.input);
      if (event.arguments_delta != null) tool.arguments = mergeValue(tool.arguments, event.arguments_delta);
      if (event.type === "tool/call/delta" && event.delta != null && event.arguments_delta == null) tool.result = mergeValue(tool.result, event.delta);
      if (event.result != null || event.output != null || event.message != null || event.error != null)
        tool.result = text(event.result ?? event.output ?? event.message ?? event.error);
      if (event.status) tool.status = STATUS_LABELS[event.status] || event.status;
      if (event.type === "tool/result" || event.type.endsWith("/end"))
        tool.status = STATUS_LABELS[event.status] || event.status || (event.error ? "失败" : "完成");
      if (event.duration_ms != null) tool.duration_ms = event.duration_ms;
      else if (event.type === "tool/result" || event.type.endsWith("/end")) tool.duration_ms = Math.max(0, eventTime(event) - tool.firstAt);
      tool.last = event;
      continue;
    }
    if (kind === "approval") {
      const approvalId = String(event.approval_id || event.id || `approval-${run.events.length}`);
      let approval = run.approvals.get(approvalId);
      if (!approval) {
        approval = {
          ...event,
          kind,
          approval_id: approvalId,
          label: DEFAULT_LABELS[event.type] || "审批",
          status: event.type === "approval/request" ? "等待审批" : "已处理",
          firstAt: eventTime(event),
        };
        run.approvals.set(approvalId, approval);
        run.events.push(approval);
      } else {
        Object.assign(approval, event);
      }
      if (event.type === "approval/result") {
        approval.status = event.status || event.option_id || (event.error ? "失败" : "已处理");
        approval.result = event.result || event.message || event.option_id || "";
        approval.options = [];
        approval.last = event;
      }
      continue;
    }
    const entry = {
      ...event,
      kind,
      label: DEFAULT_LABELS[event.type] || event.type,
      detail: text(
        event.text ?? event.delta ?? event.message ?? event.path ?? event.skill ?? event.status ?? event.result,
      ),
    };
    run.events.push(entry);
    if (event.status) run.status = STATUS_LABELS[event.status] || event.status;
    else if (event.type === "run/completed") run.status = "完成";
    else if (event.type === "run/error") run.status = "失败";
  }
  return [...runs.values()].sort((a, b) => a.startedAt - b.startedAt);
}

function eventPayload(entry) {
  const value = payloadFor(entry.last || entry);
  delete value.kind;
  delete value.label;
  delete value.closed;
  delete value.firstAt;
  return value;
}

function appendPre(parent, value) {
  if (value == null || value === "") return;
  const pre = document.createElement("pre");
  pre.textContent = text(value);
  parent.append(pre);
}

function addApprovalActions(parent, entry, approvalEndpoint) {
  const options = Array.isArray(entry.options) ? entry.options : [];
  if (!options.length || entry.type !== "approval/request") return;
  const actions = document.createElement("div");
  actions.className = "dd-harness-approval-actions";
  for (const option of options) {
    const optionValue = typeof option === "string" ? option : option.id || option.optionId || option.option_id;
    const optionLabel =
      typeof option === "string" ? option : option.label || option.title || option.name || optionValue;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = optionLabel || "选择";
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(approvalEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-DailyDesk-Request": "harness" },
          body: JSON.stringify({ approval_id: entry.approval_id, option_id: optionValue }),
        });
        if (!response.ok) throw new Error(`审批请求失败（${response.status}）`);
        actions.dataset.sent = "true";
      } catch (error) {
        button.disabled = false;
        parent.dataset.error = error.message;
      }
    });
    actions.append(button);
  }
  parent.append(actions);
}

function appendEntry(parent, entry, labels, approvalEndpoint) {
  const details = document.createElement("details");
  details.className = `dd-harness-event dd-harness-event-${entry.kind}`;
  const summary = document.createElement("summary");
  let detail = entry.detail || entry.text || entry.tool || entry.path || entry.skill || entry.status || "";
  if (entry.kind === "tool") {
    const duration = formatDuration(entry.duration_ms);
    detail = `${toolLabel(entry.tool)} · ${entry.status || "进行中"}${duration ? ` · ${duration}` : ""}`;
  }
  const label = entry.kind === "tool" ? "调用工具" : labels[entry.type] || entry.label || entry.type;
  summary.textContent = entry.kind === "reasoning" ? `思考过程 · ${entry.text?.length || 0} 字` : `${label}${detail ? ` · ${String(detail).slice(0, 180)}` : ""}`;
  details.dataset.activityKey = `${entry.run_id || "run-local"}/${entry.kind}/${entry.call_id || entry.approval_id || entry.at || ""}`;
  details.append(summary);
  const meta = document.createElement("p");
  meta.className = "dd-harness-event-meta";
  meta.textContent = `${entry.at ? new Date(entry.at).toLocaleTimeString() : ""}${entry.call_id ? ` · call ${entry.call_id}` : ""}${entry.approval_id ? ` · approval ${entry.approval_id}` : ""}`;
  details.append(meta);
  if (entry.kind === "reasoning") appendPre(details, entry.text);
  if (entry.kind === "tool") {
    appendPre(details, entry.arguments ? `参数\n${entry.arguments}` : "");
    appendPre(details, entry.result ? `结果\n${entry.result}` : "");
  }
  if (entry.kind === "attempt") {
    appendPre(details, entry.message || entry.failure?.message || "本次尝试已结束。");
    appendPre(details, entry.reasoning ? `思考\n${entry.reasoning}` : "");
    appendPre(details, entry.text ? `未提交的正文\n${entry.text}` : "");
    if (entry.tools?.length) appendPre(details, entry.tools);
    if (entry.delayMs != null) appendPre(details, `等待 ${formatDuration(entry.delayMs)} 后重试`);
  }
  if (!["reasoning", "tool", "attempt"].includes(entry.kind)) appendPre(details, eventPayload(entry));
  addApprovalActions(details, entry, approvalEndpoint);
  parent.append(details);
}

export function renderHarnessActivity(
  host,
  events,
  { labels = DEFAULT_LABELS, approvalEndpoint = "/api/harness/approval" } = {},
) {
  host.replaceChildren();
  for (const run of projectHarnessRuns(events)) {
    const details = document.createElement("details");
    details.className = "dd-harness-run";
    details.dataset.activityKey = `run/${run.id}`;
    details.open = run.status !== "失败";
    const summary = document.createElement("summary");
    summary.textContent = `${run.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "本次执行"}${run.status ? ` · ${run.status}` : ""}${run.tools.size ? ` · ${run.tools.size} 次工具调用` : ""}`;
    details.append(summary);
    const list = document.createElement("div");
    list.className = "dd-harness-events";
    const context = run.events.findLast(entry => entry.type === 'request/context');
    const connection = run.events.findLast(entry => entry.type === 'run/status' && entry.provider);
    if (context || connection) {
      const info = document.createElement('p'); info.className = 'dd-harness-event-meta';
      const modes = { fork: '继承父会话', resume: '继续节点会话', new: '新会话' };
      info.textContent = [connection && `${connection.provider} · ${connection.model}`, context && modes[context.mode],
        context?.inherited_events ? `${context.inherited_events} 条历史事件` : '',
        context?.tools?.length ? `可用工具：${context.tools.join('、')}` : ''].filter(Boolean).join(' · ');
      list.append(info);
    }
    for (const entry of run.events) if (entry.kind !== "user" && !["run/started", "run/completed", "run/status", "request/context"].includes(entry.type)) appendEntry(list, entry, labels, approvalEndpoint);
    details.append(list);
    host.append(details);
  }
}

const disclosureState = new Map();

export function reviewPresentation(node) {
  const review = node.extensions?.dailydesk?.generation?.review;
  if (!review) return null;
  if (typeof review.reviewed_markdown === 'string' && review.reviewed_markdown !== node.markdown) return { ...review, status: 'stale', label: '回答已修改，待重新核对' };
  if (review.version === 2) {
    const applied = review.applied_count || 0;
    const remaining = review.remaining_conflicts ?? review.conflicts ?? 0;
    const detail = remaining ? ` · ${remaining} 项问题保留在记录中` : review.status === 'incomplete' ? ' · 部分项目未完成核对' : '';
    return { ...review, label: `${applied ? `已依据资料修正 ${applied} 处` : '本次未修改正文'}${detail}` };
  }
  const labels = { waiting: '待核对 · 正在生成回答', running: '正在核对 · 独立 DeepSeek 与程序检查', revision_review: '正在核对修订稿', issues_found: '待核对 · 发现具体冲突', incomplete: '待核对 · 本次检查未完成', reviewed: '本次核对完成 · 所列项目未发现冲突' };
  if (typeof review.original_markdown === 'string' && review.correction_review) {
    return { ...review.correction_review, original_review: review, label: `修订稿 · ${labels[review.correction_review.status] || '待核对'}` };
  }
  return { ...review, label: labels[review.status] || '待核对' };
}

function appendReviewPanel(parent, node) {
  const review = reviewPresentation(node);
  if (!review) return;
  const box = document.createElement('details');
  box.dataset.activityKey = 'answer-review';
  box.className = 'dd-answer-review';
  box.dataset.reviewStatus = review.status;
  box.style.cssText = 'border:1px solid var(--border);border-left:3px solid var(--accent);padding:12px;margin:12px 0;border-radius:6px;line-height:1.6';
  const title = document.createElement('summary'); title.textContent = `修改与依据 · ${review.label}`; box.append(title);
  const info = document.createElement('p');
  info.textContent = review.message || `已匹配 ${review.quote_count || 0} 段源码引用；程序复算 ${(review.findings || []).filter(x => x.kind === 'arithmetic').length} 条数值等式。`;
  box.append(info);
  if (review.activity?.length) {
    const activity = document.createElement('details'); activity.dataset.activityKey = 'review-tools';
    const summary = document.createElement('summary'); summary.textContent = '审核执行记录 · 文件读取与网页搜索'; activity.append(summary);
    const host = document.createElement('div'); renderHarnessActivity(host, review.activity); activity.append(host); box.append(activity);
  }
  if (review.commentary || review.correction_review?.commentary) {
    const process = document.createElement('details'); process.dataset.activityKey = 'review-commentary';
    const summary = document.createElement('summary'); summary.textContent = '审核过程说明'; process.append(summary);
    const text = document.createElement('p'); text.style.whiteSpace = 'pre-wrap'; text.textContent = [review.commentary, review.correction_review?.commentary].filter(Boolean).join('\n'); process.append(text); box.append(process);
  }
  if (review.scope) { const scope = document.createElement('p'); scope.textContent = review.scope; box.append(scope); }
  if (review.recovery_note) { const note = document.createElement('p'); note.textContent = review.recovery_note; box.append(note); }
  for (const change of review.revisions || []) {
    const entry = document.createElement('details');
    const heading = document.createElement('summary');
    heading.textContent = `${change.status === 'applied' ? '已采用' : '未采用'} · ${change.reason}`;
    entry.append(heading);
    for (const [label, value] of [['原句', change.original], ['建议修改', change.replacement], ['局部复核', change.check_message]]) {
      const text = document.createElement('p'); text.style.whiteSpace = 'pre-wrap'; text.textContent = `${label}：${value || ''}`; entry.append(text);
    }
    for (const source of [...(change.evidence || []), ...(change.check_evidence || [])]) {
      const text = document.createElement('pre'); text.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; text.textContent = `${source.url || source.path}${source.fetched_at ? ` · 读取于 ${source.fetched_at}` : source.line_start ? ` · 第 ${source.line_start}—${source.line_end} 行` : ''}\n${source.quote}`; entry.append(text);
    }
    box.append(entry);
  }
  if (review.findings?.length) {
    const details = document.createElement('details');
    details.dataset.activityKey = 'review-findings';
    const summary = document.createElement('summary'); summary.textContent = '查看原句、检查结果和依据'; details.append(summary);
    for (const finding of review.findings) {
      const entry = document.createElement('div'); entry.style.cssText = 'margin:12px 0;padding-top:8px;border-top:1px solid var(--border)';
      const label = document.createElement('strong'); label.textContent = ({ conflict: '发现冲突', unknown: '尚未核对', checked: '程序复算一致', reviewed: 'DeepSeek认为有依据' })[finding.status] || '检查记录'; entry.append(label);
      if (finding.quote) { const quote = document.createElement('blockquote'); quote.textContent = finding.quote; quote.style.whiteSpace = 'pre-wrap'; entry.append(quote); }
      const message = document.createElement('p'); message.textContent = finding.message || ''; entry.append(message);
      for (const source of finding.evidence || []) {
        const proof = document.createElement('details'); const name = document.createElement('summary'); name.textContent = `${source.url || source.path}${source.fetched_at ? ` · 读取于 ${source.fetched_at}` : source.line_start ? ` · 第 ${source.line_start}—${source.line_end} 行` : ''}`; proof.append(name);
        const snippet = document.createElement('pre'); snippet.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere'; snippet.textContent = source.quote; proof.append(snippet); entry.append(proof);
      }
      details.append(entry);
    }
    box.append(details);
  }
  parent.append(box);
}

export function appendExecutionPanel(parent, node) {
  if (node.origin?.kind === "note") return;
  const events = node.extensions?.dailydesk?.generation?.harness_events || [];
  const question = node.origin?.web_root_question || node.origin?.question || projectHarnessRuns(events).at(-1)?.question || "";
  if (!question && !events.length) return;
  const section = document.createElement("section");
  section.className = "dd-reader-harness";
  section.dataset.nodeId = node.id;
  if (question) {
    const prompt = document.createElement("div");
    prompt.className = "dd-reader-harness-question";
    const label = document.createElement("span");
    label.className = "dd-reader-harness-label";
    label.textContent = "你的提问";
    const body = document.createElement("p");
    body.textContent = question;
    body.style.whiteSpace = "pre-wrap";
    prompt.append(label, body);
    section.append(prompt);
  }
  const storedReview = node.extensions?.dailydesk?.generation?.review;
  if (typeof storedReview?.original_markdown === 'string') {
    const heading = document.createElement('h3'); heading.textContent = '修订稿'; section.append(heading);
  }
  appendReviewPanel(section, node);
  if (typeof storedReview?.original_markdown === 'string') {
    const original = document.createElement('details');
    original.className = 'dd-original-answer';
    original.dataset.activityKey = 'original-answer';
    const label = document.createElement('summary'); label.textContent = '原回答';
    const content = document.createElement('div'); content.className = 'md';
    content.innerHTML = renderMarkdownForSurface(storedReview.original_markdown, { baseUrl: node.base_url });
    original.append(label, content);
    section.append(original);
  }
  if (node.origin?.ask_mode === 'web_search') {
    const mode = document.createElement('p'); mode.textContent = '知识搜索 · DeepSeek 根据网页来源回答'; section.append(mode);
  }
  if (events.length) {
    const details = document.createElement("details");
    details.className = "dd-reader-harness-log";
    details.dataset.activityKey = "execution";
    details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = "执行记录";
    const host = document.createElement("div");
    host.className = "dd-reader-harness-events";
    renderHarnessActivity(host, events);
    details.append(summary, host);
    section.append(details);
  }
  const state = disclosureState.get(node.id) || new Map();
  disclosureState.set(node.id, state);
  for (const candidate of section.querySelectorAll("details[data-activity-key]")) {
    if (!(candidate instanceof HTMLDetailsElement)) continue;
    const details = candidate;
    const key = details.dataset.activityKey;
    if (state.has(key)) details.open = state.get(key);
    details.addEventListener("toggle", () => { if (details.isConnected) state.set(key, details.open); });
  }
  parent.append(section);
}

const pendingPanels = new Set();
export function refreshExecutionPanels(node) {
  if (pendingPanels.has(node.id)) return;
  pendingPanels.add(node.id);
  requestAnimationFrame(() => {
    pendingPanels.delete(node.id);
    for (const existing of document.querySelectorAll(".dd-reader-harness[data-node-id]")) {
      if (existing.dataset.nodeId !== node.id) continue;
      const holder = document.createElement("div");
      appendExecutionPanel(holder, node);
      if (holder.firstElementChild) existing.replaceWith(holder.firstElementChild);
    }
  });
}

export function latestHarnessActivity(events = []) {
  const runs = projectHarnessRuns(events);
  const run = runs.at(-1);
  const entry = run?.events.at(-1);
  if (!entry) return null;
  if (entry.kind === "tool")
    return {
      label: "调用工具",
      detail: `${toolLabel(entry.tool)} · ${entry.status || "进行中"}${formatDuration(entry.duration_ms) ? ` · ${formatDuration(entry.duration_ms)}` : ""}`,
    };
  if (entry.kind === "reasoning") return { label: "思考过程", detail: entry.text || "" };
  return { label: entry.label || entry.type, detail: entry.detail || "" };
}
