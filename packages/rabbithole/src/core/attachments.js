import { validateImageAssetName } from "./assets.js";

export const MAX_ASK_ATTACHMENTS = 4;
export const ATTACHMENT_LIMIT_MESSAGE = `Up to ${MAX_ASK_ATTACHMENTS} images per ask or note.`;

/** @param {unknown} values */
export function normalizeAskAttachments(values) {
  /** @type {string[]} */
  const names = [];
  if (!Array.isArray(values)) return names;
  for (const value of values) {
    try { names.push(validateImageAssetName(value)); } catch {}
    if (names.length === MAX_ASK_ATTACHMENTS) break;
  }
  return names;
}

/** @param {unknown} values @param {string} [label] */
export function validateAskAttachments(values, label = "Ask attachments") {
  if (!Array.isArray(values) || values.length > MAX_ASK_ATTACHMENTS) throw new Error(`${label} must contain at most ${MAX_ASK_ATTACHMENTS} images`);
  return values.map((value) => validateImageAssetName(value));
}
