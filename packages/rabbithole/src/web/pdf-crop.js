import { PDF_AGENT_CROP_MAX_LONG_EDGE } from "../core/pdf-shared.js";
import { renderPdfRegion } from "../core/pdf/crop.js";
import { acquirePdfDocument } from "../ui/pdf-runtime.js";

export async function cropPdfSourceToDataUrl(blob, options) {
  return blobToDataUrl(await cropPdfSourceToBlob(blob, options));
}

/** @param {Blob} blob @param {any} [options] */
export async function cropPdfSourceToBlob(blob, { sourceKey, pageNumber, anchor = null, normalizedRect = null, padding = 12, maxLongEdge = PDF_AGENT_CROP_MAX_LONG_EDGE } = {}) {
  if (!blob) throw new Error("PDF source is missing.");
  const lease = await acquirePdfDocument({ key: `crop:${sourceKey || `${blob.size}:${blob.type}`}`, blob });
  try {
    const result = await renderPdfRegion({ document: lease.document, pageNumber, anchor, normalizedRect, padding, maxLongEdge,
      createSurface: (width, height) => {
        const surface = createCanvas(width, height);
        return { surface, context: surface.getContext("2d", { alpha: false }) };
      },
      encode: canvasToBlob,
    });
    return result.encoded;
  } finally {
    lease.release();
  }
}

function createCanvas(width, height) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height; return canvas;
}

async function canvasToBlob(canvas) {
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type: "image/png" });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Canvas could not be encoded as PNG.")), "image/png"));
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
}
