import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { stripTypeScriptTypes } from "node:module";
import { extname, resolve, sep } from "node:path";

// Превью для человека: браузер не исполняет TypeScript, поэтому .ts отдаётся уже без типов —
// тем же способом, каким их убирает сам Node при запуске тестов.
const root = process.cwd();
const port = Number(process.env.PORT);
const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".ts", "text/javascript; charset=utf-8"],
]);

if (!Number.isInteger(port) || port < 1) throw new Error("PORT is required");

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    let filename = resolve(root, `.${pathname}`);
    if (filename !== root && !filename.startsWith(`${root}${sep}`)) throw new Error("Path escapes preview root");
    if ((await stat(filename)).isDirectory()) filename = resolve(filename, "index.html");
    const extension = extname(filename).toLowerCase();
    response.setHeader("content-type", mime.get(extension) ?? "application/octet-stream");
    if (extension === ".ts") {
      response.end(stripTypeScriptTypes(await readFile(filename, "utf8")));
      return;
    }
    createReadStream(filename).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1");
