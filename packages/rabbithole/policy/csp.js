import { createHash } from "node:crypto";
import { WEB_CONNECT_SOURCES } from "./origins.js";

/** @param {{proxyOrigin?: string, canonicalHostScript: string, initialThemeScript: string}} input */
export function webContentSecurityPolicy({ proxyOrigin = "", canonicalHostScript, initialThemeScript }) {
  const connectSources = [...WEB_CONNECT_SOURCES];
  if (proxyOrigin && !connectSources.includes(proxyOrigin)) connectSources.push(proxyOrigin);
  const sha256 = (source) => createHash("sha256").update(source).digest("base64");
  return [
    "default-src 'self'",
    `script-src 'self' 'sha256-${sha256(canonicalHostScript)}' 'sha256-${sha256(initialThemeScript)}'`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' blob: data: https:",
    `connect-src ${connectSources.join(" ")}`,
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}
