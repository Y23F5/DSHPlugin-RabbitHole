let visualBaseCss = "";
let checkCss = "";
let mermaidCss = "";

export function setVisualStyles(styles) {
  visualBaseCss = styles.visualBaseCss || "";
  checkCss = styles.checkCss || "";
  mermaidCss = styles.mermaidCss || "";
}

export function visualStylesFor(type) {
  if (type === "check") return visualBaseCss + checkCss;
  if (type === "mermaid") return visualBaseCss + mermaidCss;
  return visualBaseCss;
}
