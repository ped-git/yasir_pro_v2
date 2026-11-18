#!/usr/bin/env node
// Static server for the interactive_beta reader and the shared site layer in app/.
// Binds to loopback only; falls back to the next free port when 4173 is taken.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const root = path.join(projectRoot, 'app');
const readerPath = 'interactive_beta';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2' };
let port = Number(process.env.PORT ?? 4173);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/') {
      response.writeHead(302, { Location: `/${readerPath}/` }).end();
      return;
    }
    let target = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!target.startsWith(root + path.sep) && target !== root) {
      response.writeHead(403).end();
      return;
    }
    if ((await stat(target)).isDirectory()) target = path.join(target, 'index.html');
    const content = await readFile(target);
    response.writeHead(200, { 'Content-Type': types[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' }).end(content);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') server.listen(++port, '127.0.0.1');
  else throw error;
});
server.on('listening', () => console.log(`Interactive reader: http://127.0.0.1:${port}/${readerPath}/`));
server.listen(port, '127.0.0.1');
