/**
 * Owns the shared pasted-image queue used by note surfaces. The surface keeps
 * only its acceptance policy: preview now for a draft, or upload immediately
 * for an existing note.
 */
export function wirePastedImages(options) {
  let pending = 0;
  let queue = Promise.resolve();

  function onPaste(event) {
    if (options.active && !options.active()) return;
    const files = options.readFiles(event);
    if (!files.length) return;
    const available = Math.max(0, options.limit - options.count() - pending);
    const consumed = files.slice(0, available);
    if (files.length > consumed.length) options.onLimit();
    if (!consumed.length) return;
    event.preventDefault();
    pending += consumed.length;
    options.onPending?.(pending);
    queue = queue.then(async () => {
      for (const file of consumed) {
        try {
          const normalized = await options.normalize(file);
          if (!options.active || options.active()) await options.accept(normalized);
        } catch (error) {
          options.onError(error);
        } finally {
          pending -= 1;
          options.onPending?.(pending);
        }
      }
      options.onSettled?.();
    });
  }

  options.listen(options.target, "paste", onPaste, true);
  return Object.freeze({
    settle: () => queue,
    get pending() {
      return pending;
    },
  });
}
