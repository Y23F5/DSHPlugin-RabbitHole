/** @param {unknown} query */
export function queryTerms(query) {
  const text = String(query || '').toLowerCase();
  const words = Array.from(text.matchAll(/[a-z0-9_]+(?:[.-][a-z0-9_]+)*/g), match => match[0]);
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  for (const segment of segmenter.segment(text)) {
    if (segment.isWordLike && /\p{Script=Han}/u.test(segment.segment) && segment.segment.length >= 2) words.push(segment.segment);
  }
  return [...new Set(words)].slice(0, 64);
}

/** @param {string} content */
export function textSections(content) {
  /** @type {Array<{heading: string, level: number, offset: number, line_start: number}>} */
  const headings = [];
  let offset = 0;
  let fence = null;
  let lineNumber = 1;
  for (const line of content.split('\n')) {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) {
      const delimiter = marker[1] || '';
      if (!fence) fence = delimiter;
      else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = null;
    } else if (!fence) {
      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading?.[1] && heading[2]) headings.push({ heading: heading[2], level: heading[1].length, offset, line_start: lineNumber });
    }
    offset += line.length + 1;
    lineNumber++;
  }
  return headings.map((heading, index) => ({ ...heading, end: headings.slice(index + 1).find(next => next.level <= heading.level)?.offset ?? content.length }));
}

/** @param {string} content @param {unknown} query @param {{path?: string, size?: number}} options */
export function rankedExcerpts(content, query, { path = '', size = 1800 } = {}) {
  const terms = queryTerms(query);
  const headings = textSections(content);
  const excerpts = [];
  let headingIndex = -1;
  let lineStart = 1;
  let previousOffset = 0;
  for (let offset = 0; offset < content.length; offset += size - 250) {
    while (headingIndex + 1 < headings.length && (headings[headingIndex + 1]?.offset ?? Infinity) <= offset) headingIndex++;
    for (let position = previousOffset; position < offset; position++) if (content[position] === '\n') lineStart++;
    previousOffset = offset;
    const excerpt = content.slice(offset, offset + size);
    const lower = excerpt.toLowerCase();
    const heading = headings[headingIndex]?.heading || '';
    const label = `${path} ${heading}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (lower.includes(term) ? 3 : 0) + (label.includes(term) ? 1 : 0), 0);
    if (score || (!terms.length && !offset)) excerpts.push({ content: excerpt, offset, next_offset: offset + excerpt.length < content.length ? offset + excerpt.length : null, line_start: lineStart, heading, score });
  }
  return excerpts.sort((first, second) => second.score - first.score || first.offset - second.offset);
}
