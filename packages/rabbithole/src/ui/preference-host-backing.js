const PREFERENCE_SAVE_DEBOUNCE_MS = 400;

export function createHostPreferenceBacking(options) {
  options = options || {};
  const post = typeof options.post === "function" ? options.post : function () {};
  const documentTarget = options.documentTarget || (typeof document === "undefined" ? null : document);
  const windowTarget = options.windowTarget || (typeof window === "undefined" ? null : window);
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : PREFERENCE_SAVE_DEBOUNCE_MS;
  let pending = {};
  let timer = /** @type {ReturnType<typeof setTimeout> | 0} */ (0);
  let disposed = false;
  let posting = Promise.resolve();

  function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = 0;
    }
    const values = pending;
    pending = {};
    if (!Object.keys(values).length) return posting;
    posting = posting.then(
      function () {
        return Promise.resolve(post({ type: "preferences_patch", values: values })).catch(function () {
          return null;
        });
      },
      function () {
        return Promise.resolve(post({ type: "preferences_patch", values: values })).catch(function () {
          return null;
        });
      },
    );
    return posting;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function write(key, value) {
    if (disposed) return;
    pending[key] = value;
    schedule();
  }

  function onVisibilityChange() {
    if (documentTarget.hidden) flush();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer) clearTimeout(timer);
    timer = 0;
    documentTarget?.removeEventListener("visibilitychange", onVisibilityChange);
    windowTarget?.removeEventListener("pagehide", flush);
  }

  documentTarget?.addEventListener("visibilitychange", onVisibilityChange);
  windowTarget?.addEventListener("pagehide", flush);

  return {
    seed: options.seed && typeof options.seed === "object" ? options.seed : {},
    write: write,
    flush: flush,
    dispose: dispose,
  };
}
