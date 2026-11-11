/* Servidor local para testes: serve dist/ e encaminha /api e /_blob para a função.
   Uso: DATABASE_URL=postgres://... SESSION_SECRET=... ADMIN_EMAIL=... MS_PG_DRIVER=pg node scripts/dev-server.mjs */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from '../netlify/functions/api.mjs';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };
const porta = Number(process.env.PORT || 8888);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + porta);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_blob/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const r = await handler(new Request(url, { method: req.method, headers: req.headers, body }));
    const h = {}; r.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(r.status, h); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  const arq = join(dist, url.pathname === '/' ? 'index.html' : url.pathname);
  try { const b = await readFile(arq); res.writeHead(200, { 'content-type': tipos[extname(arq)] || 'application/octet-stream' }); res.end(b); }
  catch (e) { res.writeHead(404); res.end('não encontrado'); }
}).listen(porta, () => console.log('http://localhost:' + porta));
