'use strict';
/*
 * Keeps the compact timetable fresh: downloads Metro Bilbao's official GTFS, rebuilds, caches.
 * Falls back to the snapshot shipped in public/timetable.json if the download fails.
 */
const fs = require('fs');
const path = require('path');
const { unzip } = require('./zip');
const { buildTimetable } = require('./timetable');

const GTFS_URL = process.env.GTFS_URL || 'https://cms.metrobilbao.eus/get/open_data/horarios/es';
const REFRESH_MS = +(process.env.GTFS_REFRESH_MS || 6 * 3600 * 1000);
const SNAPSHOT = path.join(__dirname, '..', 'public', 'timetable.json');
const CACHE_FILE = process.env.TIMETABLE_CACHE || path.join(require('os').tmpdir(), 'metro-bilbao-timetable.json');

let current = null; // { json: string, builtAt: ms, source }
let inflight = null;

function loadFile(file, source) {
  try {
    const json = fs.readFileSync(file, 'utf8');
    const tt = JSON.parse(json);
    return { json, builtAt: Date.parse(tt.built) || fs.statSync(file).mtimeMs, source, valid: tt.valid };
  } catch { return null; }
}

async function download(fetchImpl = fetch) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 60000);
  try {
    const r = await fetchImpl(GTFS_URL, { signal: ctl.signal, headers: { 'User-Agent': 'metro-bilbao-live (personal project)' } });
    if (!r.ok) throw new Error(`GTFS download failed: HTTP ${r.status}`);
    const files = unzip(Buffer.from(await r.arrayBuffer()));
    const tt = buildTimetable(files);
    const json = JSON.stringify(tt);
    try { fs.writeFileSync(CACHE_FILE, json); } catch { /* read-only FS (serverless) is fine */ }
    return { json, builtAt: Date.now(), source: GTFS_URL, valid: tt.valid };
  } finally { clearTimeout(t); }
}

/** Returns { json, builtAt, source }. Never throws if any timetable is available. */
async function getTimetable({ fetchImpl, log = console.log } = {}) {
  if (!current) current = loadFile(CACHE_FILE, 'cache') || loadFile(SNAPSHOT, 'bundled snapshot');
  const stale = !current || current.source !== GTFS_URL || Date.now() - current.builtAt > REFRESH_MS;
  if (stale && !inflight) {
    inflight = download(fetchImpl)
      .then(t => { current = t; log(`timetable: rebuilt from ${GTFS_URL} (valid ${t.valid.join('–')})`); })
      .catch(e => { log(`timetable: ${e.message}; using ${current ? current.source : 'nothing'}`); if (current) current.builtAt = Date.now() - REFRESH_MS + 30 * 60e3; })
      .finally(() => { inflight = null; });
  }
  if (!current && inflight) await inflight;       // first run with no snapshot: wait for the download
  if (!current) throw new Error('No timetable available');
  return current;
}

module.exports = { getTimetable, GTFS_URL };
