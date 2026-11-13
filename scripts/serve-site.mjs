// Serves a built site folder for local testing the way the hosted site answers:
// a file as it is, an address without an extension by its .html file (play is
// play.html), and any other page address by index.html.
//   node scripts/serve-site.mjs <folder> [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "build/site");
const port = Number(process.argv[3] ?? 4176);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".wav": "audio/wav",
};

const file = (name) => {
  const full = path.join(root, name);
  return full.startsWith(root) && fs.existsSync(full) && fs.statSync(full).isFile() ? full : null;
};

http
  .createServer((request, response) => {
    const name = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const found = file(name) ?? file(path.join(name, "index.html")) ?? (path.extname(name) ? null : file(`${name}.html`) ?? file("index.html"));
    if (!found) {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": types[path.extname(found)] ?? "application/octet-stream", "Cache-Control": "no-cache" });
    if (request.method === "HEAD") response.end();
    else fs.createReadStream(found).pipe(response);
  })
  .listen(port, "127.0.0.1", () => console.log(`Serving ${root} at http://localhost:${port}/`));
