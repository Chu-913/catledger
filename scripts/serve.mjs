// 极简静态服务器，仅用于本地预览/截图
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve('www');
const PORT = Number(process.env.PORT || 8899);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (url.pathname === '/' || url.pathname.endsWith('/')) p = path.join(p, 'index.html');
    if (!p.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
    const buf = await readFile(p);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  } catch (e) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => console.log('serving http://127.0.0.1:' + PORT));