export { createProvider } from "./provider/openai-compatible.js";
export { detectPdfTranscriptionCapability, pdfTranscriptionCapability } from "./provider/pdf-transcription.js";
export { isHttpUrl } from "./provider/model-endpoint.js";
export { BRIDGE_AGENT_LABELS, bridgeAgentOf } from "./provider/bridge-catalog.js";
export { DirectRabbitholeHost, createHoleFromMarkdown, createPendingHoleFromQuestion } from "./transport/direct-host.js";
export { createHarnessProvider } from "./harness/provider.js";
export { createDshProvider, DshBrowserProvider } from "./harness/dsh-provider.js";
export { HARNESS_CAPABILITIES, HARNESS_EVENT_TYPES, summarizeHarnessEvent } from "./harness/protocol.js";
export { openUrlToStoredHole } from "./ingest/url.js";
export { describePdfImportFailure, ingestPdfToStoredHole } from "./ingest/pdf.js";
export {
  buildRabbitholeExport,
  downloadRabbitholeExport,
  importRabbitholeFile,
  importSnapshotFile,
  rabbitholeFilename,
} from "./portable.js";
