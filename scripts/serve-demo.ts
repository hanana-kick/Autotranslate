// Serves the sample page and the compiled scripts it loads, so the demo runs
// over http:// (file:// would block the classic scripts from loading).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8732);

const TYPES: Record<string, string | undefined> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8'
};

function send(response: ServerResponse, status: number, type: string, body: Buffer | string): void {
  response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
}

const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(request.url ?? '/', `http://${host}`).pathname);
  } catch {
    send(response, 400, TYPES['.txt'] ?? 'text/plain', 'bad request');
    return;
  }

  const target = resolve(join(ROOT, pathname === '/' ? 'demo/index.html' : pathname));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    send(response, 403, TYPES['.txt'] ?? 'text/plain', 'forbidden');
    return;
  }

  try {
    const info = await stat(target);
    const file = info.isDirectory() ? join(target, 'index.html') : target;
    const body = await readFile(file);
    send(response, 200, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', body);
  } catch {
    send(response, 404, TYPES['.txt'] ?? 'text/plain', `not found: ${pathname}`);
  }
});

server.listen(port, host, () => {
  console.log(`Autotranslate sample: http://${host}:${port}/demo/`);
});
