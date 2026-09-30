// Stable public adapter entrypoint. Provider generation stays web-only while
// document state, durability, deletion, and browser events live in HoleEngine.
export {
  DirectRabbitholeHost,
  createHoleFromMarkdown,
  createPendingHoleFromQuestion,
  generationDocEvents,
} from "./direct-host-runtime.js";
