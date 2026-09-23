import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";

// Превью для человека: страница с отчётом о тестах проекта. Тесты запускаются заново на
// каждый запрос /tests.xml — тем же `node --test`, что и проверка, только с JUnit-отчётом.
const root = process.cwd();
const port = Number(process.env.PORT);
const mime = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
]);

if (!Number.isInteger(port) || port < 1) throw new Error("PORT is required");

function runTests() {
  return new Promise((resolveReport) => {
    const child = spawn(process.execPath, ["--test", "--test-reporter=junit"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("close", () => {
      clearTimeout(timer);
      resolveReport(output.replaceAll(`${root}${sep}`, ""));
    });
  });
}

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    if (pathname === "/tests.xml") {
      response.setHeader("content-type", "application/xml; charset=utf-8");
      response.end(await runTests());
      return;
    }
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
