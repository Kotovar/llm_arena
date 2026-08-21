import { createServer } from "node:http";
import { message } from "./message.js";

const port = Number(process.env.PORT);
createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<main><h1>${message()}</h1></main>`);
}).listen(port, "127.0.0.1");
