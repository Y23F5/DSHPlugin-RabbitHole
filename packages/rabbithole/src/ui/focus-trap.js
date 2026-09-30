// Kit-internal focus trap used only by the Popover primitive.
const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

/** @param {HTMLElement} root @param {{initialFocus?: HTMLElement, onEscape?: (event: KeyboardEvent) => void, restoreFocus?: boolean}} [options] */
export function activateFocusTrap(root, options) {
  if (!root) return function () {};
  options = options || {};
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");

  function focusables() {
    /** @type {HTMLElement[]} */
    const all = root.querySelectorAll ? Array.prototype.slice.call(root.querySelectorAll(FOCUSABLE)) : [];
    return all.filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement || el === options.initialFocus;
    });
  }

  function focusInitial() {
    const target = options.initialFocus || focusables()[0] || root;
    try {
      target.focus({ preventScroll: true });
    } catch (e) {
      try {
        target.focus();
      } catch (_e) {}
    }
  }

  function onKeydown(e) {
    if (e.key === "Escape" && typeof options.onEscape === "function") {
      e.preventDefault();
      e.stopPropagation();
      options.onEscape(e);
      return;
    }
    if (e.key !== "Tab") return;
    const items = focusables();
    if (!items.length) {
      e.preventDefault();
      root.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  document.addEventListener("keydown", onKeydown, true);
  /** @type {ReturnType<typeof setTimeout> | 0} */
  let initialFocusTimer = setTimeout(function () {
    initialFocusTimer = 0;
    focusInitial();
  }, 0);

  return function deactivateFocusTrap() {
    if (initialFocusTimer) {
      clearTimeout(initialFocusTimer);
      initialFocusTimer = 0;
    }
    document.removeEventListener("keydown", onKeydown, true);
    if (options.restoreFocus !== false && previous) {
      try {
        previous.focus({ preventScroll: true });
      } catch (e) {
        try {
          previous.focus();
        } catch (_e) {}
      }
    }
  };
}
