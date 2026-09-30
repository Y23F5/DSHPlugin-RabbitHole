import { MAX_PDF_FIGURE_ASSET_BYTES, parseFigureRefs, rewriteFigureRefs } from "../pdf-shared.js";

/**
 * Materialize valid PDF figure directives until either the asset-count or byte
 * budget is exhausted; every failure degrades to caption text.
 * @param {{ markdown: string, pdf: any, figureBudget?: {bytes: number}, assetCount: () => number | Promise<number>, makeName: (ref: any, ordinal: number) => string, materialize: (options: {ref: any, page: any, name: string}) => Promise<{bytes: number}>, discard?: (name: string) => Promise<unknown> }} options
 */
export async function materializePdfFigures({ markdown, pdf, figureBudget = { bytes: 0 }, assetCount, makeName, materialize, discard = async () => {} }) {
  const replacements = [];
  let ordinal = 0;
  for (const ref of parseFigureRefs(markdown)) {
    const page = pdf.pages.find((/** @type {any} */ entry) => entry.n === ref.page);
    let replacement = `*${ref.caption || "Figure"}*`;
    if (page && ref.rect && figureBudget.bytes < MAX_PDF_FIGURE_ASSET_BYTES) try {
      if (await assetCount() >= 200) throw new Error("asset limit");
      const name = makeName(ref, ++ordinal);
      const result = await materialize({ ref, page, name });
      if (figureBudget.bytes + result.bytes > MAX_PDF_FIGURE_ASSET_BYTES) {
        await discard(name).catch(() => {});
        throw new Error("figure budget");
      }
      figureBudget.bytes += result.bytes;
      replacement = `![${ref.caption}](asset:${name})`;
    } catch {}
    replacements.push({ ref, markdown: replacement });
  }
  return rewriteFigureRefs(markdown, replacements);
}
