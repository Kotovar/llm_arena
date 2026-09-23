import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

const root = process.cwd();
const port = Number(process.env.PORT);
const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
]);

if (!Number.isInteger(port) || port < 1) throw new Error("PORT is required");

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    let filename = resolve(root, `.${pathname}`);
    if (filename !== root && !filename.startsWith(`${root}${sep}`)) throw new Error("Path escapes preview root");
    if ((await stat(filename)).isDirectory()) filename = resolve(filename, "index.html");
    response.setHeader("content-type", mime.get(extname(filename).toLowerCase()) ?? "application/octet-stream");
    createReadStream(filename).on("error", () => response.destroy()).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}).listen(port, "127.0.0.1");
