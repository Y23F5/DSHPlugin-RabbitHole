import {
  PDF_AGENT_CROP_MAX_LONG_EDGE,
  expandPdfBounds,
  normalizedRectToPdfBounds,
  pdfAnchorBounds,
  viewportBounds,
} from "../pdf-shared.js";

/**
 * Host-independent PDF crop geometry and render pipeline. A host supplies only
 * its surface allocator and PNG encoder.
 * @param {{ document: any, pageNumber: number, anchor?: any, bounds?: any, normalizedRect?: any, padding?: number, maxLongEdge?: number, createSurface: (width: number, height: number) => {surface: any, context: any}, encode: (surface: any) => any }} options
 */
export async function renderPdfRegion({ document, pageNumber, anchor = null, bounds = null, normalizedRect = null, padding = 0, maxLongEdge = PDF_AGENT_CROP_MAX_LONG_EDGE, createSurface, encode }) {
  let page = null;
  let surface = null;
  try {
    page = await document.getPage(pageNumber);
    const baseViewport = page.getViewport({ scale: 1, rotation: page.rotate });
    let pdfBounds = bounds || (anchor ? pdfAnchorBounds(anchor, pageNumber) : null);
    if (!pdfBounds && normalizedRect) pdfBounds = normalizedRectToPdfBounds(baseViewport, normalizedRect);
    pdfBounds = expandPdfBounds(pdfBounds, page.view, padding);
    if (!pdfBounds) throw new Error("PDF crop is outside the visible page box.");
    const baseRect = viewportBounds(baseViewport, pdfBounds);
    const [baseLeft = 0, baseTop = 0, baseRight = 0, baseBottom = 0] = baseRect;
    const longEdge = Math.max(baseRight - baseLeft, baseBottom - baseTop);
    const scale = Math.max(1, Math.min((300 / 72) * (Number(page.userUnit) || 1), maxLongEdge / Math.max(1, longEdge)));
    const viewport = page.getViewport({ scale, rotation: page.rotate });
    const crop = viewportBounds(viewport, pdfBounds);
    const [cropLeft = 0, cropTop = 0, cropRight = 0, cropBottom = 0] = crop;
    const width = Math.max(1, Math.ceil(cropRight - cropLeft));
    const height = Math.max(1, Math.ceil(cropBottom - cropTop));
    const target = createSurface(width, height);
    surface = target.surface;
    target.context.fillStyle = "white";
    target.context.fillRect(0, 0, width, height);
    await page.render({ canvasContext: target.context, viewport, transform: [1, 0, 0, 1, -cropLeft, -cropTop] }).promise;
    return { encoded: await encode(surface), width, height, pdfBounds };
  } finally {
    page?.cleanup?.();
    if (surface) {
      try { surface.width = 0; surface.height = 0; } catch {}
    }
  }
}
