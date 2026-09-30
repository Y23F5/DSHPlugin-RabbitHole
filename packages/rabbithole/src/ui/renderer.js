import { createMarkdownRenderer, MARKDOWN_RENDERER_SENTINEL } from "../core/markdown-renderer.js";

let assetData = null;
let assetNames = null;
const utf8Encoder = typeof TextEncoder === "function" ? new TextEncoder() : null;

export function setRendererAssetData(data) {
  assetData = data && typeof data === "object" ? data : null;
  assetNames = assetData ? new Set(Object.keys(assetData)) : null;
}

export function registerRendererAssetName(name) {
  if (assetNames) assetNames.add(name);
}

function browserEncodeBase64Utf8(value) {
  const source = String(value == null ? "" : value);
  if (utf8Encoder) {
    const bytes = utf8Encoder.encode(source);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 8192) {
      const end = Math.min(i + 8192, bytes.length);
      let part = "";
      for (let j = i; j < end; j++) part += String.fromCharCode(bytes[j]);
      chunks.push(part);
    }
    return btoa(chunks.join(""));
  }
  return btoa(unescape(encodeURIComponent(source)));
}

function liveAssetUrl(name) {
  const slash = String.fromCharCode(47);
  return slash + "assets" + slash + name;
}

export function resolveAssetUrl(name) {
  if (assetData) return assetData[name] || "data:,";
  return liveAssetUrl(name);
}

const markdownRenderer = createMarkdownRenderer({
  encodeBase64: browserEncodeBase64Utf8,
  resolveAssetUrl: resolveAssetUrl,
});

function renderMarkdownToHtml(markdown, options) {
  return markdownRenderer.renderMarkdownToHtml(markdown, options || {});
}

export function renderMarkdownForSurface(markdown, options) {
  return renderMarkdownToHtml(markdown, { ...(options || {}), assetNames: assetNames });
}

function renderNodeMarkdown(node) {
  return renderMarkdownToHtml(node && node.markdown, {
    baseUrl: (node && node.base_url) || null,
    assetNames: assetNames,
  });
}

export function refreshNodeHtml(node) {
  if (!node) return "";
  node.html = renderNodeMarkdown(node);
  node._htmlFor = node.markdown;
  node._plainFor = null;
  return node.html;
}

export function ensureNodeHtml(node) {
  if (!node) return "";
  return node._htmlFor === node.markdown ? node.html : refreshNodeHtml(node);
}

if (typeof window !== "undefined") {
  window.__rhMarkdownRendererSentinel = MARKDOWN_RENDERER_SENTINEL;
}
