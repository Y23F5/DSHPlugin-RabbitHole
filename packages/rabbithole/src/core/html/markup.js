import { escapeHtml } from "../utils.js";

const STATEFUL_ARIA = ["aria-haspopup", "aria-controls", "aria-expanded", "aria-pressed"];
export const BUTTON_TAG = "button";
export const BUTTON_OPEN = "<button";

/** @typedef {Record<string, any>} ButtonOptions */

/** @param {string} name @param {unknown} value */
function attribute(name, value) {
  if (value === undefined || value === false || value === null) return "";
  return " " + name + (value === true ? "" : '="' + escapeHtml(String(value)) + '"');
}

/** @param {ButtonOptions} options @param {boolean} iconOnly */
function buttonAttributes(options, iconOnly) {
  const label = String(options.label || "").trim();
  const ariaLabel = String(options.ariaLabel || "").trim();
  if (iconOnly && !ariaLabel) throw new Error("IconButton requires aria-label");
  if (!iconOnly && !label && !ariaLabel) throw new Error("Button requires an accessible name");

  const baseClass = options.bare ? "" : (iconOnly ? "tool-btn tool-icon" : "tool-btn");
  const className = [baseClass, options.className].filter(Boolean).join(" ");
  let result = attribute("class", className || undefined) +
    attribute("id", options.id) +
    attribute("type", "button") +
    attribute("role", options.role) +
    attribute("tabindex", options.tabIndex) +
    attribute("title", options.title) +
    attribute("aria-label", ariaLabel || undefined);
  for (const [name, value] of Object.entries(options.dataAttrs || {})) {
    const attrName = "data-" + String(name).replace(/[A-Z]/g, (letter) => "-" + letter.toLowerCase());
    result += attribute(attrName, value);
  }
  for (const name of STATEFUL_ARIA) {
    const camelName = name.replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
    result += attribute(name, options[name] ?? options[camelName]);
  }
  const aria = options.aria || {};
  for (const [name, value] of Object.entries(aria)) {
    const attrName = name.startsWith("aria-") ? name : "aria-" + name;
    if (!STATEFUL_ARIA.includes(attrName) && attrName !== "aria-label") result += attribute(attrName, value);
  }
  return result + attribute("hidden", options.hidden) + attribute("disabled", options.disabled);
}

/** @param {ButtonOptions} [options] */
export function buttonMarkup(options = {}) {
  const rawLabel = String(options.label || "");
  const label = options.labelClass && rawLabel
    ? "<span" + attribute("class", options.labelClass) + ">" + escapeHtml(rawLabel) + "</span>"
    : escapeHtml(rawLabel);
  const content = (options.svgIconHtml || "") + label +
    (options.kbdHint ? "<kbd" + attribute("class", options.kbdClass) + ">" + escapeHtml(String(options.kbdHint)) + "</kbd>" : "");
  return "<button" + buttonAttributes(options, false) + ">" + content + "</button>";
}

// The one composer action row: a runtime-generated preset group and the shared
// commit pair. Every composer surface (selection popover, reader composer,
// card drawer, standalone note/ask surface, note editor) renders this same
// commit markup — one Note and one Ask, worded once here so no surface can
// grow a dialect; surfaces without a parent document omit lenses.
/** @param {{ id?: string, includeLenses?: boolean, includeKnowledge?: boolean }} [options] */
export function composerActionsMarkup(options = {}) {
  const lenses = options.includeLenses === false ? "" : '<div class="preset-actions" data-preset-set></div>';
  const knowledge = options.includeKnowledge === false ? "" : buttonMarkup({ bare: true, className: "ask-commit ask-knowledge", dataAttrs: { commit: "knowledge" }, title: "使用网页搜索回答，不核对项目文件", label: "知识搜索 ", labelClass: "ask-commit-label" });
  const reactions = options.id === "ask-actions"
    ? '<span class="thumb-pair">' +
      '<button type="button" class="thumb" data-react="up" title="Thumbs up" aria-label="Thumbs up">👍 <kbd>↑</kbd></button>' +
      '<button type="button" class="thumb" data-react="down" title="Thumbs down" aria-label="Thumbs down">👎 <kbd>↓</kbd></button>' +
      "</span>"
    : "";
  return '<div class="ask-actions"' + attribute("id", options.id) + ">" +
    lenses +
    reactions +
    '<div class="commit-actions">' +
    buttonMarkup({ bare: true, className: "ask-commit", dataAttrs: { commit: "note" },
      title: "Save note (Enter)",
      label: "Note ", labelClass: "ask-commit-label", kbdHint: "↵" }) +
    buttonMarkup({ bare: true, className: "ask-commit", dataAttrs: { commit: "ask" },
      title: "Ask (Command/Control+Enter)",
      label: "Ask ", labelClass: "ask-commit-label", kbdHint: "⌘↵" }) +
    knowledge +
    "</div></div>";
}

/** @param {ButtonOptions} [options] */
export function iconButtonMarkup(options = {}) {
  const content = options.svgIconHtml || escapeHtml(String(options.icon || ""));
  return "<button" + buttonAttributes(options, true) + ">" + content + "</button>";
}
