import { escapeHtml } from "../utils.js";

/**
 * Assemble the one self-contained Rabbithole page envelope. Authoring assets
 * may live in separate source files, but delivery is always one HTML response.
 * @param {{ mode: "live" | "frozen", title: string, stylesheetText: string, bodyHtml: string }} options
 */
export function assembleRabbitholePage({ mode, title, stylesheetText, bodyHtml }) {
  if (mode !== "live" && mode !== "frozen") throw new Error(`Unsupported Rabbithole page mode: ${mode}`);
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
${stylesheetText}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>`;
}
