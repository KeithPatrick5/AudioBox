'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { getLibriVox, searchOpenLibrary, getWikipediaAuthor } = require('./lib/providers');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const TYPES = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.ico':'image/x-icon', '.json':'application/json; charset=utf-8' };

function json(res, status, body, cache='no-store') {
  res.writeHead(status, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':cache });
  res.end(JSON.stringify(body));
}

async function api(req, res, url) {
  const params = Object.fromEntries(url.searchParams.entries());
  try {
    if (url.pathname === '/api/librivox') return json(res, 200, { books: await getLibriVox(params) }, 'public, max-age=300');
    if (url.pathname === '/api/openlibrary') return json(res, 200, { results: await searchOpenLibrary(params) }, 'public, max-age=86400');
    if (url.pathname === '/api/wikipedia') return json(res, 200, { author: await getWikipediaAuthor(params) }, 'public, max-age=86400');
    return json(res, 404, { error:'Not found' });
  } catch (error) {
    return json(res, 502, { error:'Upstream service unavailable', detail:error.message });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return api(req, res, url);

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = path.normalize(path.join(ROOT, requested));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, 'index.html');
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, () => console.log(`AudioBox: http://localhost:${PORT}`));
