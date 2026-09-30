// Position entrance/exit motion around the point where a surface meets the
// thing that opened it. Kept independent of the canvas runtime so every
// overlay primitive can be loaded and tested on its own.
export function setSurfaceOrigin(element, anchorRect) {
  if (!element || !anchorRect) return;
  const elementRect = element.getBoundingClientRect();
  const anchorX = anchorRect.left + anchorRect.width / 2;
  const anchorY = anchorRect.top + anchorRect.height / 2;
  const originX = Math.max(0, Math.min(elementRect.width, anchorX - elementRect.left));
  let originY;
  if (anchorRect.bottom <= elementRect.top) originY = 0;
  else if (anchorRect.top >= elementRect.bottom) originY = elementRect.height;
  else originY = Math.max(0, Math.min(elementRect.height, anchorY - elementRect.top));
  element.style.transformOrigin = Math.round(originX) + "px " + Math.round(originY) + "px";
}
