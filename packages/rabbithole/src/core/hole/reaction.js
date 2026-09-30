/** @typedef {"up" | "down"} ReactionKey */

/** @type {readonly ReactionKey[]} */
export const REACTION_KEYS = Object.freeze(["up", "down"]);

/** @type {Readonly<Record<ReactionKey, Readonly<{ glyph: string, instruction: string }>>>} */
export const DEFAULT_REACTION_PROMPTS = Object.freeze({
  up: Object.freeze({ glyph: "👍", instruction: "This landed well — use a similar approach." }),
  down: Object.freeze({ glyph: "👎", instruction: "This didn't land — take a different approach." }),
});

/** @param {unknown} value @returns {ReactionKey | null} */
export function normalizeReactionKey(value) {
  const key = String(value ?? "").trim();
  if (key === "up" || key === "down") return key;
  return REACTION_KEYS.find((candidate) => DEFAULT_REACTION_PROMPTS[candidate].glyph === key) || null;
}

/** @param {{ markdown?: unknown, origin?: any } | null | undefined} node */
export function reactionInstructionForNode(node) {
  const stored = String(node?.origin?.instruction ?? "").trim();
  if (stored) return stored.slice(0, 4000);
  const key = normalizeReactionKey(node?.markdown);
  return key ? DEFAULT_REACTION_PROMPTS[key].instruction : String(node?.markdown ?? "");
}
