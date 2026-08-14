#!/usr/bin/env node
// Minimal static server for assets/www, so the bundle can be exercised in a browser
// the way the WebView will load it. Not used at runtime by the app.
//
//   npm run serve   ->  http://localhost:5173

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const ROOT = new URL('../assets/www', import.meta.url).pathname;
const PORT = Number(process.env.PORT || 5173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  // normalize() collapses any ../ before it can escape ROOT.
  const file = join(ROOT, normalize(path) === '/' ? 'index.html' : normalize(path));

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    createReadStream(file).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${path}`);
  }
}).listen(PORT, () => console.log(`Serving assets/www on http://localhost:${PORT}`));
