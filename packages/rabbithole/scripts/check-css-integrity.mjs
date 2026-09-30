import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");

export async function cssFilesUnder(directory) {
  const files = [];
  async function walk(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile() && entry.name.endsWith(".css")) files.push(target);
    }
  }
  try {
    await walk(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return files.sort();
}

export async function inspectStylesheet(file, source) {
  const templateIndex = source.indexOf("${");
  if (templateIndex !== -1) {
    return [issue(file, source, templateIndex,
      'template interpolation fragment "${" is forbidden; CSS files are real CSS, never templates')];
  }

  const structureIssue = inspectStructure(file, source);
  if (structureIssue) return [structureIssue];

  try {
    const { transform } = await import("lightningcss");
    transform({
      filename: file,
      code: Buffer.from(source),
      errorRecovery: false,
    });
    return [];
  } catch (error) {
    const line = error?.loc?.line || 1;
    const column = error?.loc?.column || 1;
    return [`${file}:${line}:${column}: invalid CSS: ${error?.message || String(error)}`];
  }
}

export async function checkStylesheets(files, { rootDir = defaultRoot } = {}) {
  const errors = [];
  for (const file of [...new Set(files)].sort()) {
    const source = await fs.readFile(file, "utf8");
    const issues = await inspectStylesheet(displayPath(file, rootDir), source);
    errors.push(...issues);
  }
  return errors;
}

export function formatCssIntegrityFailure(errors) {
  return `CSS integrity check failed (${errors.length})\n${errors.join("\n")}\n`;
}

async function defaultStylesheets(rootDir) {
  const sourceRoot = path.join(rootDir, "src/design");
  const builtRoots = [path.join(rootDir, "dist"), path.join(rootDir, "web/dist")];
  const sourceFiles = await cssFilesUnder(sourceRoot);
  const builtFiles = (await Promise.all(builtRoots.map(cssFilesUnder))).flat().sort();
  return { sourceFiles, builtFiles };
}

function inspectStructure(file, source) {
  const stack = [];
  let quote = "";
  let quoteIndex = -1;
  let commentIndex = -1;

  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];

    if (commentIndex !== -1) {
      if (character === "*" && next === "/") {
        commentIndex = -1;
        index += 1;
      }
      continue;
    }

    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = "";
      continue;
    }

    if (character === "/" && next === "*") {
      commentIndex = index;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      quoteIndex = index;
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if ("{[(".includes(character)) {
      stack.push({ character, index });
      continue;
    }
    if (!"}])".includes(character)) continue;

    const expected = { "}": "{", "]": "[", ")": "(" }[character];
    const opener = stack.pop();
    if (!opener || opener.character !== expected) {
      return issue(file, source, index, `unmatched closing ${JSON.stringify(character)}; CSS delimiters must balance exactly`);
    }
  }

  if (commentIndex !== -1) return issue(file, source, commentIndex, "unterminated CSS comment");
  if (quote) return issue(file, source, quoteIndex, `unterminated ${JSON.stringify(quote)} string`);
  const opener = stack.pop();
  if (opener) {
    return issue(file, source, opener.index,
      `unmatched opening ${JSON.stringify(opener.character)}; CSS delimiters must balance exactly`);
  }
  return null;
}

function issue(file, source, index, message) {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const lastNewline = before.lastIndexOf("\n");
  const column = index - lastNewline;
  return `${file}:${line}:${column}: ${message}`;
}

function displayPath(file, rootDir) {
  const relative = path.relative(rootDir, file);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
}

async function main(args) {
  let sourceFiles;
  let builtFiles;
  if (args.length) {
    sourceFiles = args.map((file) => path.resolve(file));
    builtFiles = [];
  } else {
    ({ sourceFiles, builtFiles } = await defaultStylesheets(defaultRoot));
  }
  const files = [...sourceFiles, ...builtFiles];
  const errors = await checkStylesheets(files);
  if (errors.length) {
    process.stderr.write(formatCssIntegrityFailure(errors));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`ok CSS integrity: ${sourceFiles.length} source and ${builtFiles.length} built stylesheets strictly parsed; no template fragments\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) await main(process.argv.slice(2));
