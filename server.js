#!/usr/bin/env node
'use strict';
/*
 * Metro Bilbao live map: tiny zero-dependency server.
 *   node server.js            → http://localhost:8080
 * Serves the front end from public/, plus:
 *   GET /api/live       live trip predictions, vehicles and alerts from CTB GTFS-RT (cached ~12 s)
 *   GET /api/timetable  compact timetable built from Metro Bilbao's official GTFS (refreshed every 6 h)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { getLive } = require('./lib/realtime');
const { getTimetable } = require('./lib/static-feed');

const PORT = +(process.env.PORT || 8080);
const ROOT = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function send(req, res, status, body, type, extra = {}) {
  const headers = { 'Content-Type': type, 'Access-Control-Allow-Origin': '*', ...extra };
  if (typeof body === 'string') body = Buffer.from(body);
  if (body.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /json|javascript|html|css|svg/.test(type)) {
    body = zlib.gzipSync(body); headers['Content-Encoding'] = 'gzip'; headers.Vary = 'Accept-Encoding';
  }
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers); res.end(req.method === 'HEAD' ? undefined : body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/api/live') {
      const live = await getLive();
      return send(req, res, 200, JSON.stringify(live), TYPES['.json'], { 'Cache-Control': 'no-store' });
    }
    if (url.pathname === '/api/timetable') {
      const tt = await getTimetable();
      return send(req, res, 200, tt.json, TYPES['.json'], { 'Cache-Control': 'public, max-age=1800', 'X-Timetable-Source': tt.source });
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.normalize(path.join(ROOT, p));
    if (!file.startsWith(ROOT)) return send(req, res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, data) => {
      if (err) return send(req, res, 404, 'Not found', 'text/plain');
      send(req, res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': 'no-cache' });
    });
  } catch (e) {
    console.error(e);
    send(req, res, 502, JSON.stringify({ ok: false, error: String(e.message || e) }), TYPES['.json']);
  }
});

server.listen(PORT, () => {
  console.log(`Metro Bilbao live map → http://localhost:${PORT}`);
  getTimetable().catch(() => {});      // warm the timetable in the background
});
