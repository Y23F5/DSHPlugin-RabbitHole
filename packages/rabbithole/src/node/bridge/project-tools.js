import http from "node:http";
import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { extractPdfText } from "../mcp/pdf/ingest.js";

export function projectTools(library, projectId) {
  if (!projectId) return null;
  library.getProject(projectId);
  const schema = properties => ({ type: "object", properties, additionalProperties: false });
  const location = { path: { type: "string", description: "Path relative to an authorized project folder." }, root: { type: "integer", description: "Folder index from project_files, starting at 0." } };
  const definitions = [
    { name: "project_files", description: "Browse the current project's authorized local folders. Read-only. Returns folder indexes and relative paths.", inputSchema: schema({ ...location, depth: { type: "integer" } }) },
    { name: "project_search", description: "Search filenames and text in the current project's authorized local folders. Read-only.", inputSchema: { ...schema({ query: { type: "string" } }), required: ["query"] } },
    { name: "project_read", description: "Read a text file or extract PDF pages from the current project. Read-only; does not execute code. Scanned PDFs may contain no extractable text.", inputSchema: { ...schema({ ...location, offset: { type: "integer", description: "Text offset in characters." }, page: { type: "integer", description: "PDF first page, starting at 1." } }), required: ["path"] } },
  ];
  const integer = (value, fallback, minimum, maximum) => Math.min(maximum, Math.max(minimum, Number.isFinite(Number(value)) ? Math.floor(Number(value)) : fallback));
  return {
    definitions,
    async execute(name, args = {}, signal) {
      signal?.throwIfAborted();
      if (name === "project_files") return library.projectEntries(projectId, String(args.path || ""), { depth: integer(args.depth, 2, 0, 5), limit: 250, rootIndex: args.root ?? null });
      if (name === "project_search") return library.searchProject(projectId, String(args.query || ""), { limit: 30 });
      if (name !== "project_read") throw new Error(`Unknown read-only tool: ${name}`);
      const relative = String(args.path || "");
      const project = library.getProject(projectId);
      const rootIndex = integer(args.root, 0, 0, project.roots.length - 1);
      const root = project.roots[rootIndex];
      if (!root) throw new Error("当前项目没有授权目录。");
      if (/\.pdf$/i.test(relative)) {
        const file = await library.resolveProjectPath(project, root, relative);
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error("PDF 文件无效或超过 100 MB。");
        return { path: relative, root: rootIndex, ...await extractPdfText(file, { firstPage: integer(args.page, 1, 1, 100000), pageCount: 4, signal }) };
      }
      return library.readProjectFile(projectId, relative, { rootIndex, offset: integer(args.offset, 0, 0, Number.MAX_SAFE_INTEGER), length: 20000 });
    },
  };
}

export async function serveProjectTools(tools) {
  const token = randomBytes(32).toString("hex");
  const transports = new Set();
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}` || req.headers.origin) { res.writeHead(403).end(); return; }
    try {
      if (req.url === "/tools" && req.method === "GET") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(tools?.definitions || [])); return; }
      if (req.url !== "/mcp" && req.url !== "/call") { res.writeHead(404).end(); return; }
      if (req.method !== "POST") { res.writeHead(405).end(); return; }
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error("Tool request too large"); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const execute = async (name, args) => {
        if (!tools) throw new Error("当前未选择本地项目。");
        return tools.execute(name, args);
      };
      if (req.url === "/call") { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(await execute(body.name, body.arguments))); return; }
      const mcp = new Server({ name: "rabbithole-project", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools?.definitions || [] }));
      mcp.setRequestHandler(CallToolRequestSchema, async request => {
        try { return { content: [{ type: "text", text: JSON.stringify(await execute(request.params.name, request.params.arguments)) }] }; }
        catch (error) { return { isError: true, content: [{ type: "text", text: error.message }] }; }
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      transports.add(mcp);
      res.once("close", () => { transports.delete(mcp); void mcp.close(); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) { if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json" }); if (!res.writableEnded) res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, token, async close() { await Promise.allSettled([...transports].map(transport => transport.close())); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
