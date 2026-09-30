import { createModelSettings } from "./model-settings.js";
import { createOllamaRecoveryDialog } from "./ollama-recovery.js";

/** @param {{onOllamaResolved?: (result: any) => void, onSettingsChange?: () => void}} [options] */
export function createWebSettingsRuntime({ onOllamaResolved, onSettingsChange } = {}) {
  let controller = null;
  const recovery = createOllamaRecoveryDialog({
    onResolved: (result) => onOllamaResolved?.(result),
  });
  controller = createModelSettings({
    onSettingsChange,
    openOllamaRecovery: ({ settings, trigger }) => recovery.open({ settings, trigger }),
  });
  return { controller, recovery };
}
