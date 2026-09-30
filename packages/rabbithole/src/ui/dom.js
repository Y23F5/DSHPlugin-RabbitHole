/**
 * Query an element that must exist in the static Rabbithole shell.
 * @template {HTMLElement} T
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T}
 */
export function qs(selector, root = document) {
  const found = root.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`Missing HTML element: ${selector}`);
  return /** @type {T} */ (found);
}

/**
 * @template {Element} T
 * @param {string} selector
 * @param {ParentNode} [root]
 * @returns {T[]}
 */
export function qsa(selector, root = document) {
  return /** @type {T[]} */ ([...root.querySelectorAll(selector)]);
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tagName
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tagName) {
  return document.createElement(tagName);
}

/**
 * @param {EventTarget | Node | null | undefined} target
 * @param {string} selector
 * @returns {HTMLElement | null}
 */
export function closestEl(target, selector) {
  return target instanceof Element ? /** @type {HTMLElement | null} */ (target.closest(selector)) : null;
}

/**
 * @param {EventTarget} target
 * @param {string} type
 * @param {EventListenerOrEventListenerObject} listener
 * @param {boolean | AddEventListenerOptions} [options]
 * @returns {() => void}
 */
export function on(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}
