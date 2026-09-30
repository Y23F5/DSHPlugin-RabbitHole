function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scrollRange(scroller) {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function captureContentPosition(scroller) {
  if (!scroller) return null;
  const range = scrollRange(scroller);
  const position = { progress: range ? scroller.scrollTop / range : 0, block: -1, offset: 0 };
  const content = scroller.querySelector?.(".doc-content");
  if (!content) return position;
  const viewportTop = scroller.getBoundingClientRect().top;
  const blocks = Array.from(content.children);
  for (let i = 0; i < blocks.length; i++) {
    const rect = blocks[i].getBoundingClientRect();
    if (rect.bottom > viewportTop) {
      position.block = i;
      position.offset = (viewportTop - rect.top) / Math.max(1, rect.height);
      break;
    }
  }
  return position;
}

export function restoreContentPosition(scroller, position) {
  if (!scroller || !position) return;
  const range = scrollRange(scroller);
  const content = scroller.querySelector?.(".doc-content");
  const block = content && position.block >= 0 ? content.children[position.block] : null;
  if (block) {
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportTop = scrollerRect.top;
    const rect = block.getBoundingClientRect();
    const targetTop = rect.top + clamp(position.offset, -1, 1) * rect.height;
    const visualScale = scroller.offsetHeight ? scrollerRect.height / scroller.offsetHeight : 1;
    scroller.scrollTop = clamp(scroller.scrollTop + (targetTop - viewportTop) / (visualScale || 1), 0, range);
    return;
  }
  scroller.scrollTop = clamp((Number(position.progress) || 0) * range, 0, range);
}
