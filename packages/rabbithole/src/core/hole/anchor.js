/** @param {unknown} value */
export function normalizePdfAnchor(value) {
  if (!value || typeof value !== "object") return null;
  const raw = /** @type {Record<string, any>} */ (value);
  if (raw.version !== 2 || !["text", "region"].includes(raw.kind) || !Array.isArray(raw.fragments)) return null;
  const sourceSha256 = String(raw.source_sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sourceSha256) || raw.fragments.length < 1 || raw.fragments.length > 100) return null;
  const fragments = [];
  let quadCount = 0;
  for (const fragment of raw.fragments) {
    const page = Math.floor(Number(fragment?.page));
    if (!(page > 0) || !Array.isArray(fragment?.quads) || !fragment.quads.length) return null;
    const quads = [];
    for (const rawQuad of fragment.quads) {
      if (!Array.isArray(rawQuad) || rawQuad.length !== 4) return null;
      const quad = [];
      for (const point of rawQuad) {
        if (!Array.isArray(point) || point.length !== 2) return null;
        const x = Number(point[0]), y = Number(point[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e7 || Math.abs(y) > 1e7) return null;
        quad.push([roundPdfCoordinate(x), roundPdfCoordinate(y)]);
      }
      if (Math.abs(quadArea(quad)) < 1e-8) return null;
      quads.push(quad);
      quadCount += 1;
      if (quadCount > 5000) return null;
    }
    fragments.push({ page, quads });
  }
  return { version: 2, source_sha256: sourceSha256, kind: raw.kind, fragments };
}

/** @param {unknown} value */
export function normalizeBlockAnchor(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = /** @type {Record<string, any>} */ (value);
  const blockId = String(raw.block_id || "").trim();
  const selectedText = String(raw.selected_text || "").trim().slice(0, 2000);
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/i.test(blockId) || !selectedText) return null;
  return { block_id: blockId, selected_text: selectedText };
}

/** @param {unknown} anchor @returns {any} */
export function normalizeAnchor(anchor) {
  if (!anchor) return null;
  if (Object.prototype.hasOwnProperty.call(/** @type {object} */ (anchor), "block")) {
    const block = normalizeBlockAnchor(/** @type {{ block?: unknown }} */ (anchor).block);
    return block ? { block } : null;
  }
  const start = Math.max(0, Number(/** @type {{ offset_start?: unknown }} */ (anchor).offset_start) || 0);
  const end = Math.max(start, Number(/** @type {{ offset_end?: unknown }} */ (anchor).offset_end) || start);
  /** @type {{ offset_start: number, offset_end: number, pdf?: any }} */
  const out = { offset_start: start, offset_end: end };
  const pdf = normalizePdfAnchor(/** @type {{ pdf?: unknown }} */ (anchor).pdf);
  if (pdf) out.pdf = pdf;
  return out;
}

/** @param {number} value */
function roundPdfCoordinate(value) {
  return Math.round(value * 10000) / 10000;
}

/** @param {number[][]} quad */
function quadArea(quad) {
  let area = 0;
  for (let index = 0; index < quad.length; index += 1) {
    const current = quad[index], next = quad[(index + 1) % quad.length];
    if (!current || !next) continue;
    const [currentX, currentY] = /** @type {[number, number]} */ (current);
    const [nextX, nextY] = /** @type {[number, number]} */ (next);
    area += currentX * nextY - nextX * currentY;
  }
  return area / 2;
}
