import { MAX_ASK_ATTACHMENTS } from "../../core/attachments.js";
import { validateImageAssetName } from "../../core/assets.js";
import { collectRelevantNotes, isNoteNode } from "../../core/hole/ask.js";
import { Run } from "../../core/hole/run.js";
import { lineageNodesFromMap } from "../../core/hole/tree.js";
import { holeStateToHole } from "../../core/hole/reduce.js";
import { buildNodeAnsweredEvent } from "../../core/hole-host.js";
import { normalizePdfExtension } from "../../core/pdf-shared.js";
import { ProviderError, normalizeProviderError } from "../provider/errors.js";
import { fallbackTitleForNode } from "../provider/title-sentinel.js";
import { cropPdfSourceToDataUrl } from "../pdf-crop.js";
import { DirectHostPdf } from "./direct-host-pdf.js";
import {
  blobToDataUrl,
  branchAnsweredFields,
  generationDocEvents,
  isAuthError,
  rawOrigin,
  resetMarkdownForRun,
  rootAnsweredFields,
  rootQuestionForNode,
  titleFromMarkdown,
} from "./direct-host-values.js";
import { isHarnessEvent, summarizeHarnessEvent } from "../harness/protocol.js";

/** Provider generation, retries, error routing, and context assembly. */
export class DirectHostGeneration extends DirectHostPdf {
  handleRetry(payload) {
    const node = this.state.nodes.get(String(payload.node_id || ""));
    if (!node || node.status !== "pending") return { ok: true };
    this.engine.patchExtension(node.id, "dailydesk", { ...node.extensions?.dailydesk, paused: false });
    this.state = this.engine.state;
    if (node.id === this.state.root_id && rootQuestionForNode(node)) {
      this.startRootAnswer({ reset: true });
      return { ok: true };
    }
    this.startAnswer(node.id, { reset: true, withoutAttachment: payload.without_attachment === true });
    return { ok: true };
  }

  async handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.state.root_id) return { ok: false, error: "The starting document can't be removed" };
    if (!this.state.nodes.has(targetId)) return { ok: true, deleted: [] };

    const result = await this.engine.deleteNode(targetId, {
      beforeDelete: (ids) => {
        for (const id of ids) {
          this.abortByNode.get(id)?.abort();
          this.abortByNode.delete(id);
          this.noteConversions.delete(id);
        }
      },
    });
    this.state = this.engine.state;
    return result;
  }

  async handleCancel(payload) {
    const nodeId = String(payload.node_id || "");
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return { ok: true };
    this.abortByNode.get(nodeId)?.abort();
    this.abortByNode.delete(nodeId);
    this.engine.patchExtension(nodeId, "dailydesk", { ...node.extensions?.dailydesk, paused: true });
    this.state = this.engine.state;
    this.emit({ type: "node_error", node_id: nodeId, code: "cancelled", message: "问题、引用和已生成内容已保留。", retryable: true, markdown: node.markdown || "" });
    await this.flushSave();
    return { ok: true };
  }

  dispatch(event, options) {
    const effects = this.engine.dispatch(event, options);
    this.state = this.engine.state;
    return effects;
  }

  applyPersistedBrowserEvent(payload) {
    const result = this.engine.applyPersistedEvent(payload);
    this.state = this.engine.state;
    return result;
  }

  startAnswer(nodeId, { reset = false, withoutAttachment = false } = {}) {
    if (this.disposed) return;
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;

    const controller = new AbortController();
    const previous = this.abortByNode.get(nodeId);
    if (previous) previous.abort();
    this.abortByNode.set(nodeId, controller);

    if (reset) {
      this.dispatchProgress(nodeId, "", { emit: true });
    }

    queueMicrotask(() => this.runAnswer(nodeId, controller, { withoutAttachment }).catch((err) => {
      return this.handleAnswerError(nodeId, err, controller.signal);
    }));
  }

  startRootAnswer({ reset = false } = {}) {
    if (this.disposed) return false;
    const node = this.state.nodes.get(this.state.root_id);
    const question = rootQuestionForNode(node);
    if (!node || node.status !== "pending" || !question) return false;
    if (node.extensions?.dailydesk?.paused && !reset) return false;

    const controller = new AbortController();
    const previous = this.abortByNode.get(node.id);
    if (previous) previous.abort();
    this.abortByNode.set(node.id, controller);

    if (reset) {
      this.dispatchProgress(node.id, "", { emit: true });
    }

    queueMicrotask(() => this.runRootAnswer(node.id, question, controller).catch((err) => {
      return this.handleAnswerError(node.id, err, controller.signal);
    }));
    return true;
  }

  async runRootAnswer(nodeId, question, controller) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    if (!this.provider) {
      throw new ProviderError(this.providerRequiredError?.message || "Add your provider key to keep asking.", {
        status: 401,
        code: this.providerRequiredError?.code || "missing_key",
        retryable: true,
      });
    }

    const provider = this.provider;
    const run = this.createRun(node, node.title || "Untitled", provider);
    await this.flushSave();
    const runProvider = this.providerForRun(provider, { node, run, kind: "explainer" });
    const project_context = this.projectContextLoader ? await this.projectContextLoader({ node, context: { question } }) : null;
    if (controller.signal.aborted) return;
    const generation = runProvider.authorExplainer({ question, project_context, learning: { hole_id: this.holeId, node_id: nodeId } }, controller.signal);
    for await (const docEvent of generationDocEvents(generation, run, {
      nodeId,
      progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
      answeredFields: () => rootAnsweredFields(this.state.nodes.get(nodeId)),
      beforeComplete: (activeRun) => {
        // Deliberate asymmetry: branches accept an empty stream, but a root
        // explainer preserves the existing empty/whitespace rejection surface.
        if (!activeRun.snapshot().markdown.trim()) throw new Error("The provider returned an empty document.");
        activeRun.accept({
          type: "title",
          title: titleFromMarkdown(activeRun.snapshot().markdown) || this.state.nodes.get(nodeId)?.title || "Untitled",
        });
      },
    })) {
      if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
      this.dispatch(docEvent);
      if (docEvent.type === "node_progress") {
        const current = this.state.nodes.get(nodeId);
        this.emit({ ...docEvent, markdown: current.markdown });
        this.scheduleSave();
      }
    }
    const title = this.state.nodes.get(nodeId).title;
    this.dispatch({ type: "hole_title", title });
    this.title = title;
    const finalNode = this.state.nodes.get(nodeId);
    this.abortByNode.delete(nodeId);
    this.emit(buildNodeAnsweredEvent(finalNode, { parent_id: null }));
    await this.flushSave();
    await this.onRootAnswered?.(finalNode);
  }

  async runAnswer(nodeId, controller, { withoutAttachment = false } = {}) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    if (!this.provider) {
      throw new ProviderError(this.providerRequiredError?.message || "Add your provider key to keep asking.", {
        status: 401,
        code: this.providerRequiredError?.code || "missing_key",
        retryable: true,
      });
    }

    const provider = this.provider;
    const context = this.buildBranchContext(node);
    if (node.origin?.ask_mode !== "web_search" && this.projectContextLoader) {
      context.project_context = await this.projectContextLoader({ node, context });
    }
    if (controller.signal.aborted) return;
    if (!withoutAttachment) await this.attachBranchImage(node, context);
    const fallbackTitle = fallbackTitleForNode(node);
    context.fallbackTitle = fallbackTitle;
    // Each attempt, including a retry, gets a fresh run id. The reducer can
    // therefore reject late progress from the superseded attempt.
    const run = this.createRun(node, fallbackTitle, provider);
    await this.flushSave();
    // Capture the provider at attempt start: provider changes affect only later
    // generations; this in-flight iterator finishes on the old provider.
    let runProvider = this.providerForRun(provider, { node, run, kind: "branch" });
    let generation = runProvider.answerBranch(context, controller.signal);
    const events = generationDocEvents(generation, run, {
      nodeId,
      progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
      answeredFields: () => branchAnsweredFields(this.state.nodes.get(nodeId)),
    });
    try {
      for await (const docEvent of events) {
        if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
        this.dispatch(docEvent);
        if (docEvent.type === "node_progress") {
          const current = this.state.nodes.get(nodeId);
          this.emit({ ...docEvent, markdown: current.markdown });
          this.scheduleSave();
        }
      }
    } catch (error) {
      if ((!context.attachment && !context.attachments?.length) || controller.signal.aborted) throw error;
      if (normalizeProviderError(error).code === "model_no_images") throw error;
      const hadPastedImages = !!context.attachments?.some((attachment) => attachment?.source === "pasted_image");
      delete context.attachment;
      delete context.attachments;
      this.dispatchProgress(nodeId, "", { emit: true });
      const retryRun = this.createRun(this.state.nodes.get(nodeId), fallbackTitle, provider);
      await this.flushSave();
      runProvider = this.providerForRun(provider, { node: this.state.nodes.get(nodeId), run: retryRun, kind: "branch" });
      generation = runProvider.answerBranch(context, controller.signal);
      for await (const docEvent of generationDocEvents(generation, retryRun, {
        nodeId,
        progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
        answeredFields: () => branchAnsweredFields(this.state.nodes.get(nodeId)),
      })) {
        if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
        this.dispatch(docEvent);
        if (docEvent.type === "node_progress") {
          const current = this.state.nodes.get(nodeId);
          this.emit({ ...docEvent, markdown: current.markdown });
          this.scheduleSave();
        }
      }
      if (hadPastedImages) this.onToast?.({ message: "Answered without the pasted image(s) — the request was too large for this model." });
    }

    // Branches deliberately accept an empty provider stream: completion uses
    // the fallback title and empty/reset markdown. Root generation still rejects.
    const finalNode = this.state.nodes.get(nodeId);
    this.abortByNode.delete(nodeId);
    this.noteConversions.delete(nodeId);
    this.emit(buildNodeAnsweredEvent(finalNode));
    await this.flushSave();
  }

  async attachBranchImage(node, context) {
    const pastedAssets = [];
    for (const rawName of Array.isArray(node.origin?.attachment_assets) ? node.origin.attachment_assets : []) {
      try { pastedAssets.push(validateImageAssetName(rawName)); } catch {}
      if (pastedAssets.length === MAX_ASK_ATTACHMENTS) break;
    }
    if (pastedAssets.length) {
      const attachments = [];
      for (const name of pastedAssets) {
        try {
          const blob = await this.store.getAsset(this.holeId, name);
          if (blob) attachments.push({ kind: "image", data_url: await blobToDataUrl(blob), source: "pasted_image", name });
        } catch {}
      }
      if (attachments.length) context.attachments = attachments;
      return;
    }
    const parent = this.state.nodes.get(node.parent_id ?? this.state.root_id);
    const anchor = rawOrigin(node).anchor?.pdf;
    const inheritedAnchor = node.parent_id == null ? null : (anchor || rawOrigin(parent).anchor?.pdf);
    let sourceNode = parent;
    while (sourceNode && !normalizePdfExtension(sourceNode)) sourceNode = this.state.nodes.get(sourceNode.parent_id);
    const pdf = normalizePdfExtension(sourceNode);
    const pageNumber = inheritedAnchor?.fragments?.[0]?.page;
    if (pdf && pageNumber) try {
      const blob = await this.store.getAsset(this.holeId, pdf.source.asset);
      const dataUrl = await cropPdfSourceToDataUrl(blob, { sourceKey: pdf.source.sha256, pageNumber, anchor: inheritedAnchor });
      context.attachments = [{ kind: "image", data_url: dataUrl, page: pageNumber, source: "selection_crop" }];
      return;
    } catch {}
  }

  createRun(node, fallbackTitle = fallbackTitleForNode(node), provider = this.provider) {
    const runId = this.mintRunId();
    const previous = this.state.nodes.get(node.id)?.extensions?.dailydesk || {};
    this.engine.patchExtension(node.id, 'dailydesk', { ...previous, paused: false, generation: { ...provider?.provenance, run_id: runId, started_at: new Date().toISOString(), harness_events: previous.generation?.harness_events || [], error: null, review: null } });
    this.state = this.engine.state;
    return new Run({
      id: runId,
      initialMarkdown: resetMarkdownForRun(node),
      fallbackTitle,
    });
  }

  providerForRun(provider, { node, run, kind }) {
    if (!provider || typeof this.harnessProviderFactory !== "function") return provider;
    return this.harnessProviderFactory(provider, {
      sessionId: this.holeId,
      projectId: this.projectId || node?.extensions?.dailydesk?.project_id || "",
      runId: run?.id,
      nodeId: node?.id,
      parentRunId: this.state.nodes.get(node?.parent_id)?.extensions?.dailydesk?.generation?.run_id || '',
      kind,
      onEvent: (event) => this.handleHarnessEvent(event),
    });
  }

  handleHarnessEvent(event) {
    if (!isHarnessEvent(event)) return;
    if (event.type === "assistant/message" || event.type.startsWith("assistant/text/")) return;
    const nodeId = String(event.node_id || "");
    const node = this.state.nodes.get(nodeId);
    if (node) {
      const extension = node.extensions?.dailydesk || {};
      const generation = extension.generation || {};
      if (event.type.startsWith('review/') && generation.run_id && event.run_id !== generation.run_id) return;
      const history = Array.isArray(generation.harness_events) ? generation.harness_events : [];
      const summary = event.type === 'review/activity' ? null : summarizeHarnessEvent(event);
      const previous = history.at(-1);
      if (summary?.type === "run/error" && history.some(item => item.type === summary.type && item.run_id === summary.run_id && item.message === summary.message)) return;
      let nextHistory = summary ? [...history, summary] : history;
      const field = summary?.type === "assistant/reasoning/delta" ? "delta" : summary?.type === "tool/call/delta" ? (summary.arguments_delta != null ? "arguments_delta" : "delta") : null;
      if (field && previous?.type === summary.type && previous.run_id === summary.run_id && previous.call_id === summary.call_id && previous.block_id === summary.block_id && previous.attempt_id === summary.attempt_id) nextHistory = [...history.slice(0, -1), { ...previous, [field]: String(previous[field] || "") + String(summary[field] || "") }];
      const nextGeneration = {
        ...generation,
        session_id: event.session_id || generation.session_id || this.holeId,
        run_id: event.run_id || generation.run_id,
        harness: "rabbithole-local",
        harness_events: nextHistory,
        ...(event.type === 'review/status' ? { review: { ...generation.review, status: event.status, message: event.message } } : {}),
        ...(event.type === 'review/activity' ? { review: { ...generation.review, activity: [...(generation.review?.activity || []), event.activity] } } : {}),
        ...(event.type === 'review/result' ? { review: { ...event.review, reviewed_markdown: node.markdown } } : {}),
      };
      this.engine.patchExtension(nodeId, "dailydesk", { ...extension, generation: nextGeneration });
      this.state = this.engine.state;
      this.emit({ type: "node_extensions_patch", node_id: nodeId, namespace: "dailydesk", value: { ...extension, generation: nextGeneration } });
      if (event.type !== "assistant/message") this.scheduleSave();
    }
    this.emit({ type: "harness_event", event });
    this.onHarnessEvent?.(event);
  }

  async authorDocument(source, { onProgress = null } = {}) {
    const nodeId = this.state.root_id;
    const node = this.state.nodes.get(nodeId);
    if (!node || !this.provider) throw new Error("Document authoring requires a pending root and provider.");
    const controller = new AbortController();
    this.abortByNode.get(nodeId)?.abort();
    this.abortByNode.set(nodeId, controller);
    const run = this.createRun({ ...node, markdown: "" }, node.title || "Untitled");
    await this.flushSave();
    const runProvider = this.providerForRun(this.provider, { node, run, kind: "authoring" });
    const generation = runProvider.authorDocument(source, controller.signal);
    try {
      for await (const docEvent of generationDocEvents(generation, run, {
        nodeId,
        progressFields: { base_url: node.base_url, base_url_source: node.base_url_source },
        answeredFields: () => rootAnsweredFields(this.state.nodes.get(nodeId)),
        beforeComplete: (activeRun) => {
          activeRun.accept({ type: "title", title: titleFromMarkdown(activeRun.snapshot().markdown) || node.title || "Untitled" });
        },
        complete: (activeRun, context) => ({
          ...activeRun.complete(context),
          // Authoring replaces its source, falling back to that source when the model returns no text.
          markdown: activeRun.snapshot().markdown.trim() || String(source.markdown || ""),
        }),
      })) {
        if (controller.signal.aborted || this.disposed) throw new DOMException("Aborted", "AbortError");
        this.dispatch(docEvent);
        if (docEvent.type === "node_progress") {
          onProgress?.(this.state.nodes.get(nodeId).markdown.length);
        }
      }
      this.title = this.state.nodes.get(nodeId).title;
      this.dispatch({ type: "hole_title", title: this.title });
      await this.flushSave();
      return holeStateToHole(this.state);
    } finally {
      this.saveChain.cancel();
      if (this.abortByNode.get(nodeId) === controller) this.abortByNode.delete(nodeId);
    }
  }

  async handleAnswerError(nodeId, err, signal) {
    if (signal?.aborted) return;
    this.abortByNode.delete(nodeId);
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    const normalized = normalizeProviderError(err);
    if (normalized.code === "abort") return;
    const extension = node.extensions?.dailydesk || {};
    const failure = { message: normalized.message, code: normalized.code, retryable: normalized.retryable };
    this.handleHarnessEvent({ type: "run/error", at: new Date().toISOString(), node_id: nodeId, run_id: extension.generation?.run_id || "", message: normalized.message, status: "failed" });
    const current = this.state.nodes.get(nodeId)?.extensions?.dailydesk || extension;
    const saved = { ...current, paused: true, generation: { ...current.generation, error: failure, finished_at: new Date().toISOString() } };
    this.engine.patchExtension(nodeId, "dailydesk", saved);
    this.state = this.engine.state;
    this.emit({ type: "node_extensions_patch", node_id: nodeId, namespace: "dailydesk", value: saved });
    const replacedNote = this.noteConversions.get(nodeId);
    if (replacedNote) {
      this.noteConversions.delete(nodeId);
      this.state.nodes.set(nodeId, replacedNote);
      this.emit({ type: "node_error", node_id: nodeId, message: normalized.message,
        code: normalized.code, retryable: false, restore_note: true });
      this.scheduleSave();
      return;
    }
    if (isAuthError(normalized)) {
      this.onAuthRequired?.({ node, error: normalized, retry: () => this.handleRetry({ node_id: nodeId }) });
    } else if (["network", "agent_signed_out", "agent_missing", "model_unknown", "model_no_images", "payload_too_large", "turn_failed"].includes(normalized.code)) {
      this.onProviderFailure?.({
        node,
        error: normalized,
        retry: ({ withoutAttachment = false } = {}) => this.handleRetry({ node_id: nodeId, without_attachment: withoutAttachment }),
      });
    }
    this.emit({
      type: "node_error",
      node_id: nodeId,
      message: normalized.message,
      code: normalized.code,
      retryable: normalized.retryable,
      markdown: node.markdown || "",
    });
    await this.flushSave();
  }

  dispatchProgress(nodeId, markdown, { emit = false } = {}) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    // Deliberately untagged: this is a one-shot retry reset/replacement, not
    // generation progress, so Run ordering does not apply.
    this.dispatch({
      type: "node_progress",
      node_id: nodeId,
      markdown,
      base_url: node.base_url,
      base_url_source: node.base_url_source,
    });
    const current = this.state.nodes.get(nodeId);
    if (emit) {
      // This mirrors the deliberately untagged reset above to the local UI; it
      // is not a streamed generation event and must not claim a run identity.
      this.emit({
        type: "node_progress",
        node_id: nodeId,
        markdown: current.markdown,
        base_url: current.base_url,
        base_url_source: current.base_url_source,
      });
    }
    this.scheduleSave();
  }

  buildBranchContext(node) {
    const root = this.state.nodes.get(this.state.root_id);
    const parent = this.state.nodes.get(node.parent_id ?? this.state.root_id);
    const lineage = parent ? lineageNodesFromMap(this.state.nodes, parent.id) : [];
    const ancestors = lineage.filter((entry) => entry.id !== parent?.id).map((entry) => ({
      id: entry.id,
      title: entry.title,
      markdown: entry.markdown,
      question: entry.origin?.question || "",
    }));
    return {
      root_title: root?.title || this.state.title || "Untitled",
      root_question: root?.origin?.question || "",
      hole_id: this.holeId,
      node_id: node.id,
      parent_id: parent?.id || null,
      parent_title: parent?.title || "Untitled",
      parent_markdown: parent?.markdown || "",
      ancestors,
      notes: collectRelevantNotes(this.state.nodes, parent?.id || this.state.root_id),
      selected_text: node.parent_id == null ? "" : (node.origin?.selected_text || ""),
      question: node.origin?.question || "",
      lens: node.origin?.lens || null,
      instruction: node.origin?.instruction || null,
      ask_mode: node.origin?.ask_mode || "project",
      anchor: node.origin?.anchor || null,
    };
  }

}
