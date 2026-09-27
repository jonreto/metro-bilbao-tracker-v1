/* Metro Bilbao Live — front end. Vanilla JS + SVG, no dependencies.
 *
 * Data:
 *   timetable  api/timetable → timetable.json → window.__MB_TT (inline, standalone build)
 *   basemap    basemap.json  → window.__MB_BM
 *   live       api/live (CTB GTFS-Realtime via server.js / Vercel function), polled every 15 s
 */
(() => {
'use strict';

const CFG = Object.assign({
  live: 'api/live',
  timetable: ['api/timetable', 'timetable.json'],
  basemap: 'basemap.json',
  pollMs: 15000,
  tiles: false,   // Esri keyless tiles are personal-use only; set a keyed tileUrl and turn this on
  tileUrl: {
    light: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  },
  tileMaxZoom: 16,
  tileAttribution: 'Tiles © Esri, HERE, Garmin, © OpenStreetMap contributors',
}, window.MB_CONFIG || {});
const STANDALONE = !!window.__MB_STANDALONE;

const NS = 'http://www.w3.org/2000/svg';
const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const ease = t => t < .5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
const safeLS = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

/* =====================================================================
 * Time (always Europe/Madrid, whatever the viewer's zone)
 * ===================================================================== */
const { partsAt, madridEpoch, ymd } = MBCore;
// ?at=2026-09-27T00:26 (Madrid time) freezes the start of the clock for testing; ?speed=10 fast-forwards
const qs = new URLSearchParams(location.search);
const T0 = Date.now();
let clockShift = 0, speed = +(qs.get('speed') || 1);
if (qs.get('at')) {
  const m = qs.get('at').match(/(\d{4})-(\d\d)-(\d\d)[T ](\d\d):(\d\d)(?::(\d\d))?/);
  if (m) clockShift = madridEpoch(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0)) - T0;
}
const nowMs = () => T0 + clockShift + (Date.now() - T0) * speed;
const SIMULATED = clockShift !== 0 || speed !== 1;

const pad2 = n => String(n).padStart(2, '0');
const hhmm = ms => { const p = partsAt(ms); return p.hour + ':' + p.minute; };
const hhmmss = ms => { const p = partsAt(ms); return p.hour + ':' + p.minute + ':' + p.second; };

/* =====================================================================
 * Data
 * ===================================================================== */
let D = null;       // timetable
let BM = null;      // basemap
async function getJSON(url) { const r = await fetch(url, { cache: 'no-cache' }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); }
async function loadTimetable() {
  if (window.__MB_TT) return window.__MB_TT;
  for (const u of [].concat(CFG.timetable)) { try { return await getJSON(u); } catch { /* try next */ } }
  throw new Error('Could not load the timetable');
}
async function loadBasemap() {
  if (window.__MB_BM) return window.__MB_BM;
  try { return await getJSON(CFG.basemap); } catch { return null; }
}

/* ---------- derived structures ---------- */
let SEG = {}, tripIdx = new Map(), profPos = [], canonical = {}, stationLines = [], stationRole = [];
function prepare() {
  for (const k in D.seg) {
    const a = D.seg[k], pts = [];
    for (let i = 0; i < a.length; i += 2) pts.push([a[i], a[i + 1]]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    SEG[k] = { pts, cum, len: cum[cum.length - 1], line: D.segLine ? D.segLine[k] : 0 };
  }
  D.trips.forEach((t, i) => tripIdx.set(String(t[3]), i));
  profPos = D.prof.map(p => { const m = new Map(); p[0].forEach((s, k) => { if (!m.has(s)) m.set(s, k); }); return m; });
  // canonical path of each line, oriented from the south-east (Etxebarri) outwards
  const byName = n => D.st.findIndex(s => s[0].toLowerCase().startsWith(n));
  const ETX = byName('etxebarri'), SIN = byName('san ignazio');
  const tripsPer = new Array(D.prof.length).fill(0); D.trips.forEach(t => tripsPer[t[1]]++);
  for (const L of [1, 2]) {
    let best = null, bc = -1;
    D.prof.forEach((p, i) => { if (p[2] === L && tripsPer[i] > bc) { bc = tripsPer[i]; best = p[0]; } });
    if (!best) continue;
    let seq = best.slice();
    if (seq.indexOf(ETX) > seq.indexOf(SIN)) seq.reverse();
    canonical[L] = seq;
  }
  stationLines = D.st.map(() => 0);
  D.prof.forEach(p => p[0].forEach(s => { stationLines[s] |= p[2]; }));
  for (const L of [1, 2]) (canonical[L] || []).forEach(s => { stationLines[s] |= 0; });
  const termini = new Set(); D.prof.forEach(p => { termini.add(p[0][0]); termini.add(p[0][p[0].length - 1]); });
  const MAJOR = /^(abando|zazpikaleak|moyua|san ignazio|etxebarri|plentzia|kabiezes|basauri)/i;
  stationRole = D.st.map((s, i) => {
    const onBoth = canonical[1] && canonical[2] && canonical[1].includes(i) && canonical[2].includes(i);
    return { major: MAJOR.test(s[0]), terminus: termini.has(i), trunk: onBoth };
  });
}

/* ---------- service calendar & delays (see core.js) ---------- */
let M = null; // model built in start()
const contexts = ms => M.contexts(ms);
const delaysFor = (i, info, ctx) => M.delaysFor(i, info, ctx);
const tripWindow = (i, ctx, rt) => M.tripWindow(i, ctx, rt);
const stopTimes = (i, ctx, rt, k, dly) => M.stopTimes(i, ctx, k, dly);

/* =====================================================================
 * Real-time: delays per trip
 * ===================================================================== */
const RT = {
  state: STANDALONE ? 'offline' : 'loading', data: null, fetchedAt: 0, error: null,
  trips: new Map(),   // key `${tripIdx}@${ds}` → { d:Float64Array, prev, t0, v, rel, skip:Set, ts }
  matched: 0, unmatched: 0, alerts: [],
};

function applyLive(live) {
  const now = nowMs();
  const ctxs = contexts(now);
  const next = new Map(); let matched = 0, unmatched = 0;
  for (const id in live.trips) {
    const i = tripIdx.get(String(id));
    if (i === undefined) { unmatched++; continue; }
    const info = live.trips[id];
    let best = null, bestCtx = null;
    for (const c of ctxs) {
      if (!c.svc.has(D.trips[i][0])) continue;
      const r = delaysFor(i, info, c);
      if (r && Math.abs(r.med) < 3 * 3600 && (!best || Math.abs(r.med) < Math.abs(best.med))) { best = r; bestCtx = c; }
    }
    if (!best) { unmatched++; continue; }
    matched++;
    const key = i + '@' + bestCtx.ds;
    const old = RT.trips.get(key);
    const cur = old ? currentDelays(old, performance.now()) : null;
    next.set(key, { d: best.d, prev: cur, t0: performance.now(), v: info.v, rel: info.rel, skip: best.skip, ts: info.ts });
  }
  RT.trips = next; RT.matched = matched; RT.unmatched = unmatched;
  RT.alerts = live.alerts || [];
  renderAlertsButton();
}
const BLEND_MS = 4000;
function currentDelays(r, t) {
  if (!r.prev) return r.d;
  const f = ease(clamp((t - r.t0) / BLEND_MS, 0, 1));
  if (f >= 1) { r.prev = null; return r.d; }
  const out = new Float64Array(r.d.length);
  for (let k = 0; k < out.length; k++) out[k] = (r.prev[k] ?? r.d[k]) + (r.d[k] - (r.prev[k] ?? r.d[k])) * f;
  return out;
}
async function pollLive() {
  if (STANDALONE || !CFG.live) { RT.state = 'offline'; renderStatus(); return; }
  try {
    const r = await fetch(CFG.live, { cache: 'no-store' });
    if (r.status === 404) { RT.state = 'offline'; renderStatus(); return; }   // served without the API: timetable mode
    const live = await r.json();
    if (!live.ok) throw new Error((live.errors || []).join('; ') || live.error || 'Live feed unavailable');
    RT.data = live; RT.fetchedAt = Date.now(); RT.error = null;
    applyLive(live);
    const age = live.now - (live.feedTime || live.now);
    RT.state = age > 180 && !SIMULATED ? 'stale' : 'live';
  } catch (e) {
    RT.error = e.message || String(e);
    RT.state = RT.data && Date.now() - RT.fetchedAt < 120e3 ? 'stale' : 'error';
    if (RT.state === 'error') RT.trips = new Map();
  }
  renderStatus();
}

/* =====================================================================
 * Train state
 * ===================================================================== */
const hidden = new Set(JSON.parse(safeLS.get('mb-hidden-lines') || '[]'));
let active = [];              // [{i, ctx, key, rt}]
function refreshActive() { active = M.activeTrips(nowMs(), RT.trips); }
function trainPosition(a, now, tNow) {
  const [, pi] = D.trips[a.i], P = D.prof[pi], seq = P[0], n = seq.length;
  const dly = a.rt ? currentDelays(a.rt, tNow) : null;
  let prevDep = null;
  for (let k = 0; k < n; k++) {
    const [arr, dep] = stopTimes(a.i, a.ctx, a.rt, k, dly);
    if (now < arr && k > 0 && prevDep !== null) {
      const f = clamp((now - prevDep) / Math.max(1, arr - prevDep), 0, 1);
      const g = along(seq[k - 1], seq[k], smoothRun(f));
      return { ...g, dwell: false, k: k - 1, next: k, f, dly };
    }
    if (now >= arr && now <= dep || (k === 0 && now < arr) || (k === n - 1 && now >= arr)) {
      const g = k + 1 < n ? along(seq[k], seq[k + 1], 0) : along(seq[k - 1], seq[k], 1);
      return { x: D.st[seq[k]][1], y: D.st[seq[k]][2], dx: g.dx, dy: g.dy, dwell: true, k, next: Math.min(k + 1, n - 1), f: 0, dly };
    }
    prevDep = dep;
  }
  return null;
}
// trains accelerate out of and brake into stations rather than moving at constant speed
const smoothRun = f => { const a = .18; if (f < a) return f * f / (2 * a * (1 - a)); if (f > 1 - a) return 1 - (1 - f) ** 2 / (2 * a * (1 - a)); return (f - a / 2) / (1 - a); };
function along(a, b, f) {
  let s = SEG[a + '-' + b], rev = false;
  if (!s) { s = SEG[b + '-' + a]; rev = true; }
  if (!s) { const A = D.st[a], B = D.st[b]; return { x: A[1] + (B[1] - A[1]) * f, y: A[2] + (B[2] - A[2]) * f, dx: B[1] - A[1], dy: B[2] - A[2] }; }
  const target = (rev ? 1 - f : f) * s.len;
  let lo = 1, hi = s.cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s.cum[mid] < target) lo = mid + 1; else hi = mid; }
  const i = lo, p0 = s.pts[i - 1], p1 = s.pts[i], sl = (s.cum[i] - s.cum[i - 1]) || 1, t = clamp((target - s.cum[i - 1]) / sl, 0, 1);
  let dx = p1[0] - p0[0], dy = p1[1] - p0[1]; if (rev) { dx = -dx; dy = -dy; }
  return { x: p0[0] + (p1[0] - p0[0]) * t, y: p0[1] + (p1[1] - p0[1]) * t, dx, dy };
}
const lineOfTrip = i => D.prof[D.trips[i][1]][2];
const destOf = i => { const s = D.prof[D.trips[i][1]][0]; return D.st[s[s.length - 1]][0]; };
const originOf = i => D.st[D.prof[D.trips[i][1]][0][0]][0];
const short = n => n.split('/')[0];
function delayClass(d) { if (d == null) return 'sched'; if (d <= -60) return 'early'; if (d < 120) return 'ok'; if (d < 300) return 'warn'; return 'bad'; }
function fmtDelay(d) {
  if (d == null) return 'Timetable';
  const a = Math.abs(Math.round(d));
  if (a < 30) return 'On time';
  const m = Math.floor(a / 60), s = a % 60;
  return (d < 0 ? '−' : '+') + (m ? m + ':' + pad2(s) : a + ' s');
}
function unitSeries(v) { const n = parseInt(v, 10); if (!n) return null; if (n >= 600) return '600 series'; if (n >= 550) return '550 series'; if (n >= 500) return '500 series'; return null; }

/* =====================================================================
 * View, projection, basemap
 * ===================================================================== */
const svg = $('map'), world = $('world');
let W = 0, H = 0;
let view = { s: 0.02, cx: 0, cy: 0 };
let limits = { sMin: 0.005, sMax: 1.6, x0: -60000, x1: 60000, y0: -40000, y1: 40000 };
const sx = x => (x - view.cx) * view.s + W / 2;
const sy = y => (y - view.cy) * view.s + H / 2;
const wx = px => (px - W / 2) / view.s + view.cx;
const wy = py => (py - H / 2) / view.s + view.cy;

function decodeRing(a, q) {
  let x = a[0], y = a[1]; let d = 'M' + x * q + ' ' + y * q;
  for (let i = 2; i < a.length; i += 2) { x += a[i]; y += a[i + 1]; d += 'l' + a[i] * q + ' ' + a[i + 1] * q; }
  return d;
}
function drawBasemap() {
  const base = $('bm-base'), over = $('bm-over');
  base.textContent = ''; over.textContent = '';
  if (!BM) return;
  const q = BM.q;
  const polys = (arr, cls, parent) => { if (!arr) return; let d = ''; for (const poly of arr) for (const r of poly) d += decodeRing(r, q) + 'z'; el('path', { d, class: cls, 'fill-rule': 'evenodd' }, parent); };
  const lines = (arr, cls, parent) => { if (!arr) return; let d = ''; for (const l of arr) d += decodeRing(l, q); el('path', { d, class: cls }, parent); };
  const b = BM.bounds.map(v => v * q);
  el('rect', { x: b[0] - 2e5, y: b[1] - 2e5, width: b[2] - b[0] + 4e5, height: b[3] - b[1] + 4e5, class: 'bm-sea' }, base);
  polys(BM.land, 'bm-land-out', base);
  polys(BM.biz, 'bm-land', base);
  // Bizkaia outline also clips the optional tile layer so the map stops at the province border
  let clip = ''; for (const poly of BM.biz) for (const r of poly) clip += decodeRing(r, q) + 'z';
  $('bizClipPath').setAttribute('d', clip);
  polys(BM.water, 'bm-water', over);
  lines(BM.munilines, 'bm-muni', over);
  lines(BM.rivers, 'bm-river', over);
  lines(BM.trunks, 'bm-road2', over);
  lines(BM.motorways, 'bm-road', over);
  let border = ''; for (const poly of BM.biz) border += decodeRing(poly[0], q) + 'z';
  el('path', { d: border, class: 'bm-coast' }, over);
  // province limits: pan/zoom never leave Bizkaia
  const bz = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const poly of BM.biz) { const r = poly[0]; let x = r[0], y = r[1]; for (let i = 0; i < r.length; i += 2) { if (i) { x += r[i]; y += r[i + 1]; } bz.x0 = Math.min(bz.x0, x * q); bz.x1 = Math.max(bz.x1, x * q); bz.y0 = Math.min(bz.y0, y * q); bz.y1 = Math.max(bz.y1, y * q); } }
  limits.x0 = bz.x0; limits.x1 = bz.x1; limits.y0 = bz.y0; limits.y1 = bz.y1;
}
function computeLimits() {
  W = svg.clientWidth; H = svg.clientHeight;
  const pad = 24;
  limits.sMin = Math.min((W - pad * 2) / (limits.x1 - limits.x0), (H - pad * 2) / (limits.y1 - limits.y0));
  limits.sMax = 1.6;
}
function constrain() {
  view.s = clamp(view.s, limits.sMin, limits.sMax);
  // keep the viewport centre inside Bizkaia's bounding box
  view.cx = clamp(view.cx, limits.x0, limits.x1);
  view.cy = clamp(view.cy, limits.y0, limits.y1);
}
function networkBounds() {
  const xs = D.st.map(s => s[1]), ys = D.st.map(s => s[2]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
function fitNetwork(animate) {
  const b = networkBounds();
  const narrow = W < 760;
  const cardB = $('card').getBoundingClientRect().bottom;
  const padL = narrow ? 40 : 360, padR = narrow ? 40 : ($('app').classList.contains('panel-open') ? 410 : 70);
  const padT = narrow ? cardB + 24 : 40, padB = narrow ? 36 : 40;
  const s = Math.min((W - padL - padR) / (b.x1 - b.x0), (H - padT - padB) / (b.y1 - b.y0));
  const cx = (b.x0 + b.x1) / 2 - ((padL - padR) / 2) / s, cy = (b.y0 + b.y1) / 2 - ((padT - padB) / 2) / s;
  flyTo({ s, cx, cy }, animate ? 600 : 0);
}
let flight = null;
function flyTo(target, ms) {
  if (!ms || matchMedia('(prefers-reduced-motion: reduce)').matches) { Object.assign(view, target); constrain(); onView(); return; }
  flight = { from: { ...view }, to: target, t0: performance.now(), ms };
}
function stepFlight(t) {
  if (!flight) return;
  const f = ease(clamp((t - flight.t0) / flight.ms, 0, 1));
  const ls0 = Math.log(flight.from.s), ls1 = Math.log(flight.to.s);
  view.s = Math.exp(ls0 + (ls1 - ls0) * f);
  view.cx = flight.from.cx + (flight.to.cx - flight.from.cx) * f;
  view.cy = flight.from.cy + (flight.to.cy - flight.from.cy) * f;
  constrain(); onView();
  if (f >= 1) flight = null;
}
function zoomAt(k, px, py) {
  const x = wx(px), y = wy(py);
  view.s = clamp(view.s * k, limits.sMin, limits.sMax);
  view.cx = x - (px - W / 2) / view.s; view.cy = y - (py - H / 2) / view.s;
  constrain(); onView();
}
let viewDirty = true;
function onView() { viewDirty = true; }
function applyView() {
  world.setAttribute('transform', `translate(${W / 2 - view.cx * view.s} ${H / 2 - view.cy * view.s}) scale(${view.s})`);
  drawTiles(); drawTracks(); drawStations(); drawPlaces();
  viewDirty = false;
}

/* ---------- tiles (optional, clipped to Bizkaia) ---------- */
const MERC = 2 * Math.PI * 6378137, X0 = 6378137 * (-2.95 * Math.PI / 180), Y0 = 6378137 * Math.log(Math.tan(Math.PI / 4 + 43.28 * Math.PI / 360));
let tilesOn = false, tilesFailed = 0, tilesOk = 0;
const tileEls = new Map();
const isDark = () => { const t = document.documentElement.getAttribute('data-theme'); return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches; };
function drawTiles() {
  const g = $('tiles');
  if (!tilesOn) { if (tileEls.size) { g.textContent = ''; tileEls.clear(); } return; }
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let z = Math.ceil(Math.log2(view.s * dpr * MERC / 256));
  z = clamp(z, 8, CFG.tileMaxZoom);
  const n = 2 ** z, size = MERC / n;
  const x0 = Math.max(wx(0), limits.x0), x1 = Math.min(wx(W), limits.x1), y0 = Math.max(wy(0), limits.y0), y1 = Math.min(wy(H), limits.y1);
  const tx0 = Math.floor((x0 + X0 + MERC / 2) / size), tx1 = Math.floor((x1 + X0 + MERC / 2) / size);
  const ty0 = Math.floor((MERC / 2 - (Y0 - y0)) / size), ty1 = Math.floor((MERC / 2 - (Y0 - y1)) / size);
  const want = new Set(), theme = isDark() ? 'dark' : 'light';
  for (let tx = tx0; tx <= tx1; tx++) for (let ty = ty0; ty <= ty1; ty++) {
    const key = `${theme}/${z}/${tx}/${ty}`; want.add(key);
    if (tileEls.has(key)) continue;
    const img = el('image', {
      x: tx * size - MERC / 2 - X0, y: Y0 - (MERC / 2 - ty * size), width: size + size / 256, height: size + size / 256, preserveAspectRatio: 'none',
    }, g);
    img.addEventListener('load', () => { tilesOk++; });
    img.addEventListener('error', () => { tilesFailed++; img.remove(); if (tilesFailed > 6 && !tilesOk) { setTiles(false, true); } });
    img.setAttribute('href', CFG.tileUrl[theme].replace('{z}', z).replace('{x}', tx).replace('{y}', ty));
    tileEls.set(key, { img, z });
  }
  // keep lower-zoom tiles underneath briefly to avoid flashes; drop everything not wanted at other zooms
  for (const [k, t] of tileEls) if (!want.has(k) && (t.z !== z || !k.startsWith(theme))) {
    if (Math.abs(t.z - z) > 1 || !k.startsWith(theme)) { t.img.remove(); tileEls.delete(k); }
  }
  for (const [k, t] of tileEls) if (t.z === z) g.appendChild(t.img); // current zoom on top
}
function setTiles(on, failed) {
  tilesOn = on;
  $('app').classList.toggle('tiles-on', on);
  $('tiles-btn').setAttribute('aria-pressed', on);
  if (!failed) safeLS.set('mb-tiles', on ? '1' : '0');
  if (failed) { $('tiles-btn').hidden = true; toast('Detailed map tiles could not load here, so the built-in map is shown.'); }
  renderAttribution(); onView();
}

/* ---------- tracks ---------- */
function offsetPolyline(pts, off) {
  if (!off) return pts;
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], a = pts[i - 1] || p, b = pts[i + 1] || p;
    let n1x = 0, n1y = 0, n2x = 0, n2y = 0;
    if (i > 0) { const dx = p[0] - a[0], dy = p[1] - a[1], L = Math.hypot(dx, dy) || 1; n1x = -dy / L; n1y = dx / L; }
    if (i < pts.length - 1) { const dx = b[0] - p[0], dy = b[1] - p[1], L = Math.hypot(dx, dy) || 1; n2x = -dy / L; n2y = dx / L; }
    if (i === 0) { n1x = n2x; n1y = n2y; } if (i === pts.length - 1) { n2x = n1x; n2y = n1y; }
    let nx = n1x + n2x, ny = n1y + n2y; const L = Math.hypot(nx, ny) || 1; nx /= L; ny /= L;
    const cos = nx * n2x + ny * n2y; const m = off / Math.max(cos, .5);
    out.push([p[0] + nx * m, p[1] + ny * m]);
  }
  return out;
}
const trackWidth = () => clamp(2.5 + Math.log2(view.s / limits.sMin + 1) * 0.9, 3, 7);
function segOrientedPts(key) {
  // returns the segment's screen points oriented along the line's canonical direction
  const s = SEG[key]; const [a, b] = key.split('-').map(Number);
  let pts = s.pts.map(p => [sx(p[0]), sy(p[1])]);
  for (const L of [1, 2]) {
    const c = canonical[L]; if (!c) continue;
    const ia = c.indexOf(a), ib = c.indexOf(b);
    if (ia >= 0 && ib >= 0) { if (ia > ib) pts = pts.reverse(); break; }
  }
  return pts;
}
function drawTracks() {
  const g = $('tracks'); g.textContent = '';
  const w = trackWidth(), off = w / 2 + 0.6;
  const casing = [], strokes = { 1: [], 2: [], 0: [] };
  const pathOf = pts => 'M' + pts.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L');
  for (const k in SEG) {
    const m = SEG[k].line || 0;
    const pts = segOrientedPts(k);
    casing.push(pathOf(pts));
    if (m === 3) { strokes[1].push(pathOf(offsetPolyline(pts, -off))); strokes[2].push(pathOf(offsetPolyline(pts, off))); }
    else if (m === 1 || m === 2) strokes[m].push(pathOf(pts));
    else strokes[0].push(pathOf(pts));
  }
  el('path', { d: casing.join(''), class: 'track casing', 'stroke-width': w * 2 + 5 }, g);
  el('path', { d: strokes[0].join(''), class: 'track l0', 'stroke-width': w * .7 }, g);
  for (const L of [2, 1]) el('path', { d: strokes[L].join(''), class: 'track l' + L + (hidden.has(L) ? ' dim' : ''), 'stroke-width': w }, g);
}

/* ---------- stations & labels ---------- */
let stnEls = [], labelBoxes = [];
function buildStations() {
  const g = $('stations'); g.textContent = '';
  stnEls = D.st.map(([name], i) => {
    const grp = el('g', { class: 'stn', tabindex: '0', role: 'button', 'aria-label': name + ' station' }, g);
    const hit = el('circle', { class: 'hit' }, grp);
    const mk = el('rect', { class: 'mk' }, grp);
    grp.addEventListener('click', e => { if (dragMoved < 6) { e.stopPropagation(); select({ type: 'stn', id: i }); } });
    grp.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ type: 'stn', id: i }, { focus: true }); } });
    const r = stationRole[i];
    if (r.terminus || r.major) grp.classList.add('term');
    return { g: grp, hit, mk };
  });
}
function labelSide(i) {
  // put labels on the outside of each branch; trunk labels go below the line
  const L = stationLines[i], r = stationRole[i];
  if (r.trunk) return 'below';
  if (L === 2) return 'left';
  return 'right';
}
function drawStations() {
  const w = trackWidth(), lg = $('labels');
  lg.textContent = ''; labelBoxes = [];
  const zoomK = view.s / limits.sMin;
  D.st.forEach(([name, x, y], i) => {
    const e = stnEls[i], px = sx(x), py = sy(y), r = stationRole[i];
    const size = r.trunk ? w * 2 + 3 : w + 4.5;
    const big = r.terminus || r.major ? 1.5 : 0;
    e.mk.setAttribute('x', px - size / 2 - big / 2); e.mk.setAttribute('y', py - (w + 4.5) / 2 - big / 2);
    e.mk.setAttribute('width', size + big); e.mk.setAttribute('height', w + 4.5 + big);
    e.mk.setAttribute('rx', (w + 4.5 + big) / 2);
    // rotate trunk markers across both tracks
    if (r.trunk) {
      const ang = stationAngle(i);
      e.mk.setAttribute('transform', `rotate(${ang + 90} ${px} ${py})`);
    } else e.mk.removeAttribute('transform');
    e.hit.setAttribute('cx', px); e.hit.setAttribute('cy', py); e.hit.setAttribute('r', 13);
  });
  // labels: selected, termini and interchanges first, then the rest if they fit
  const order = D.st.map((_, i) => i).sort((a, b) => labelPri(b) - labelPri(a));
  ctx2d.font = '600 12px Archivo, Arial, sans-serif';
  for (const i of order) {
    const [name, x, y] = D.st[i], r = stationRole[i];
    const pri = labelPri(i);
    if (zoomK < 1.6 && pri < 2) continue;
    const text = short(name), big = r.terminus || r.major;
    const tw = ctx2d.measureText(text).width * (big ? 1.12 : 1) * .92, th = big ? 14 : 13;
    const px = sx(x), py = sy(y), side = labelSide(i), gap = trackWidth() + 6;
    const cands = side === 'below' ? [['m', px, py + gap + th - 3], ['m', px, py - gap - 2], ['s', px + gap, py + 4]]
      : side === 'left' ? [['e', px - gap, py + 4], ['s', px + gap, py + 4], ['m', px, py + gap + th - 3]]
        : [['s', px + gap, py + 4], ['e', px - gap, py + 4], ['m', px, py + gap + th - 3]];
    for (const [anc, lx, ly] of cands) {
      const bx = anc === 's' ? lx : anc === 'e' ? lx - tw : lx - tw / 2, by = ly - th + 2;
      const box = [bx - 2, by - 1, tw + 4, th + 2];
      if (labelBoxes.some(b => overlap(b, box)) || stationBoxHit(box, i)) continue;
      labelBoxes.push(box);
      const t = el('text', { x: lx, y: ly, class: 'lbl' + (big ? ' big' : '') + (selected && selected.type === 'stn' && selected.id === i ? ' sel' : ''), 'text-anchor': anc === 's' ? 'start' : anc === 'e' ? 'end' : 'middle' }, lg);
      t.textContent = text;
      break;
    }
  }
}
function labelPri(i) {
  const r = stationRole[i];
  if (selected && selected.type === 'stn' && selected.id === i) return 5;
  if (r.terminus && /plentzia|kabiezes|basauri|etxebarri/i.test(D.st[i][0])) return 4;
  if (r.major) return 3;
  if (r.terminus) return 2;
  return 1;
}
const overlap = (a, b) => a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1];
function stationBoxHit(box, self) {
  for (let j = 0; j < D.st.length; j++) {
    if (j === self) continue;
    const px = sx(D.st[j][1]), py = sy(D.st[j][2]);
    if (px > box[0] - 5 && px < box[0] + box[2] + 5 && py > box[1] - 5 && py < box[1] + box[3] + 5) return true;
  }
  return false;
}
function stationAngle(i) {
  for (const k in SEG) {
    const [a, b] = k.split('-').map(Number);
    if (a === i || b === i) { const s = SEG[k].pts; const p0 = a === i ? s[0] : s[s.length - 1], p1 = a === i ? s[1] : s[s.length - 2]; return Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI; }
  }
  return 0;
}
const ctx2d = document.createElement('canvas').getContext('2d');

/* ---------- place names (municipalities, the sea) ---------- */
// official bilingual names are long; use the short everyday form on the map
const PLACE_ALIAS = { 'Abanto y Cirvana-Abanto Zierbena': 'Abanto', 'Abanto y Ciérvana-Abanto Zierbena': 'Abanto', 'Valle de Trpaga-Trapagaran': 'Trapagaran',
  'Valle de Trápaga-Trapagaran': 'Trapagaran', 'Trucios-Turtzioz': 'Turtzioz', 'Munitibar-Arbatzegi Gerrikaitz-': 'Munitibar', 'Karrantza Harana/Valle de Carranza': 'Karrantza',
  'Karrantza Harana': 'Karrantza', 'Valle de Villaverde': 'Villaverde', 'Arratzu': 'Arratzu' };
const METRO_TOWNS = /^(Bilbao|Getxo|Barakaldo|Portugalete|Santurtzi|Sestao|Leioa|Erandio|Basauri|Etxebarri|Sopela|Berango|Urduliz|Plentzia|Galdakao|Durango|Bermeo|Gernika|Mungia|Balmaseda|Lekeitio|Ondarroa|Amorebieta)/;
function drawPlaces() {
  if (!BM || !BM.labels) return;
  const lg = $('labels'), q = BM.q, zoomK = view.s / limits.sMin;
  ctx2d.font = '600 10.5px Archivo, Arial, sans-serif';
  // the sea
  const seaX = sx(8000), seaY = sy(-26000);
  if (seaY > 60 && seaY < H - 20) {
    const t = el('text', { x: seaX, y: seaY, class: 'place sea', 'text-anchor': 'middle' }, lg);
    t.textContent = 'Bizkaiko Golkoa · Golfo de Bizkaia';
  }
  const list = BM.labels.map(l => ({ name: PLACE_ALIAS[l[0]] || l[0], x: l[1] * q, y: l[2] * q, area: l[3], metro: METRO_TOWNS.test(l[0]) }))
    .sort((a, b) => (b.metro - a.metro) || (b.area - a.area));
  let shown = 0; const maxN = zoomK < 1.5 ? 10 : zoomK < 4 ? 28 : 80;
  for (const p of list) {
    if (shown >= maxN) break;
    if (!p.metro && zoomK < 2.2 && p.area < 40) continue;
    const px = sx(p.x), py = sy(p.y);
    if (px < -50 || px > W + 50 || py < -20 || py > H + 20) continue;
    const text = p.name.toUpperCase();
    const tw = ctx2d.measureText(text).width * 1.25 + text.length * 1.4, th = 12;
    const box = [px - tw / 2 - 3, py - th, tw + 6, th + 4];
    if (labelBoxes.some(b => overlap(b, box)) || stationBoxHit(box, -1)) continue;
    labelBoxes.push(box); shown++;
    const t = el('text', { x: px, y: py, class: 'place', 'text-anchor': 'middle' }, lg);
    t.textContent = text;
    lg.insertBefore(t, lg.firstChild);
  }
}

/* =====================================================================
 * Trains on the map
 * ===================================================================== */
const trainEls = new Map();
function trainShape(line) {
  const g = el('g', { class: 'train enter l' + line });
  el('circle', { class: 'hit', r: 14 }, g);
  const rot = el('g', { class: 'rot' }, g);
  for (const c of ['shadow', 'halo', 'dwell', 'body', 'roof', 'panto', 'glass', 'head', 'tail']) el(c === 'halo' || c === 'dwell' ? 'rect' : 'path', { class: c }, rot);
  el('circle', { class: 'dly', r: 3.6 }, g);
  return g;
}
const carsOf = unit => (parseInt(unit, 10) >= 600 ? 5 : 4);   // every 600-series unit runs with 5 cars; most 500/550s with 4
/** Top-down sprite pointing +x: separate cars, cab windscreen, pantographs, head and tail lights. */
function spritePaths(len, wid, n) {
  const gap = Math.max(0.9, len * 0.014), cl = (len - gap * (n - 1)) / n, r = wid / 2, h = len / 2;
  let body = '', roof = '', panto = '';
  for (let c = 0; c < n; c++) {
    const x0 = -h + c * (cl + gap), x1 = x0 + cl;
    const front = c === n - 1, rear = c === 0;
    const rf = front ? r * 1.05 : 1.2, rr = rear ? r * .7 : 1.2;
    body += `M${x0 + rr} ${-r}H${x1 - rf}Q${x1} ${-r} ${x1} ${-r + rf}V${r - rf}Q${x1} ${r} ${x1 - rf} ${r}H${x0 + rr}Q${x0} ${r} ${x0} ${r - rr}V${-r + rr}Q${x0} ${-r} ${x0 + rr} ${-r}Z`;
    if (len >= 30) { const a0 = x0 + (rear ? r * 1.2 : cl * .12), a1 = x1 - (front ? r * 1.6 : cl * .12); roof += `M${a0} ${-r * .28}H${a1}V${r * .28}H${a0}Z`; }
    const pan = n === 5 ? (c === 1 || c === 3) : (c === 1 || c === 2);
    if (pan && len >= 38) { const m = (x0 + x1) / 2, q = Math.min(cl * .2, r * .7); panto += `M${m - q} ${-q * .7}H${m + q}V${q * .7}H${m - q}Z M${m} ${-q * .7}V${q * .7}`; }
  }
  const xf = h, g = `M${xf - r * .95} ${-r * .72}Q${xf - r * .35} ${-r * .8} ${xf - .9} ${-r * .38}V${r * .38}Q${xf - r * .35} ${r * .8} ${xf - r * .95} ${r * .72}Z`;
  const dot = (x, y, rad) => `M${x - rad} ${y}a${rad} ${rad} 0 1 0 ${rad * 2} 0a${rad} ${rad} 0 1 0 ${-rad * 2} 0`;
  const lr = Math.max(.9, wid * .1);
  const head = len >= 24 ? dot(xf - .8, -r * .55, lr) + dot(xf - .8, r * .55, lr) : '';
  const tail = len >= 24 ? dot(-h + .9, -r * .55, lr * .85) + dot(-h + .9, r * .55, lr * .85) : '';
  return { body, roof, panto, glass: g, head, tail };
}
function updateTrains(tNow) {
  const now = nowMs() / 1000;
  const g = $('trains');
  const alive = new Set();
  const Lm = 72 * view.s; // real unit length on screen
  const len = clamp(Lm, 19, 90), wid = clamp(len * .36, 8.5, 15);
  const off = trackWidth() / 2 + wid / 2 + 2.5;
  const counts = { 1: 0, 2: 0 };
  for (const a of active) {
    const line = lineOfTrip(a.i);
    const pos = trainPosition(a, now, tNow);
    if (!pos) continue;
    counts[line]++;
    alive.add(a.key);
    let e = trainEls.get(a.key);
    if (!e) {
      const node = trainShape(line);
      node.addEventListener('click', ev => { if (dragMoved < 6) { ev.stopPropagation(); select({ type: 'train', key: a.key }); } });
      node.setAttribute('role', 'button'); node.setAttribute('tabindex', '-1');
      g.appendChild(node);
      e = { node, rot: node.querySelector('.rot'), dly: node.querySelector('.dly'), hit: node.querySelector('.hit'), shape: '' };
      trainEls.set(a.key, e);
      setTimeout(() => node.classList.remove('enter'), 700);
    }
    e.a = a; e.pos = pos;
    const L = Math.hypot(pos.dx, pos.dy) || 1, ux = pos.dx / L, uy = pos.dy / L;
    const px = sx(pos.x) - uy * off, py = sy(pos.y) + ux * off;
    const ang = Math.atan2(uy, ux) * 180 / Math.PI;
    e.node.setAttribute('transform', `translate(${px.toFixed(1)} ${py.toFixed(1)})`);
    e.rot.setAttribute('transform', `rotate(${ang.toFixed(1)})`);
    const n = carsOf(a.rt && a.rt.v), tl = n === 5 ? len * 1.2 : len;
    const shapeKey = tl.toFixed(0) + '/' + wid.toFixed(0) + '/' + n;
    if (e.shape !== shapeKey) {
      e.shape = shapeKey;
      const P = spritePaths(tl, wid, n), q = c => e.rot.querySelector('.' + c);
      for (const k of ['body', 'roof', 'panto', 'glass', 'head', 'tail']) q(k).setAttribute('d', P[k]);
      q('shadow').setAttribute('d', P.body); q('shadow').setAttribute('transform', 'translate(1 2)');
      const h = tl / 2, r = wid / 2;
      for (const [node, grow] of [[q('halo'), 4], [q('dwell'), 1]]) {
        node.setAttribute('x', -h - grow); node.setAttribute('y', -r - grow); node.setAttribute('width', tl + grow * 2); node.setAttribute('height', wid + grow * 2); node.setAttribute('rx', r + grow);
      }
      e.hit.setAttribute('r', Math.max(14, tl / 2));
    }
    const d = pos.dly ? pos.dly[pos.dwell ? pos.k : pos.next] : null;
    const cls = a.rt ? delayClass(d) : 'sched';
    e.node.classList.toggle('dwelling', pos.dwell);
    e.node.classList.toggle('sched', !a.rt && RT.state === 'live');
    e.node.classList.toggle('sel', !!(selected && selected.type === 'train' && selected.key === a.key));
    e.node.classList.toggle('hidden', hidden.has(line));
    e.dly.setAttribute('class', 'dly ' + cls);
    e.dly.setAttribute('cx', (uy * (wid / 2 + 4)).toFixed(1)); e.dly.setAttribute('cy', (-ux * (wid / 2 + 4)).toFixed(1));
    e.dly.style.display = a.rt && cls !== 'sched' ? '' : 'none';
    e.node.setAttribute('aria-label', `${line === 1 ? 'L1' : 'L2'} train to ${short(destOf(a.i))}, ${a.rt ? fmtDelay(d) : 'timetable position'}`);
  }
  for (const [k, e] of trainEls) if (!alive.has(k)) { e.node.remove(); trainEls.delete(k); }
  // keep the selected train on top
  if (selected && selected.type === 'train') { const e = trainEls.get(selected.key); if (e && e.node !== g.lastChild) g.appendChild(e.node); }
  return counts;
}

/* =====================================================================
 * Panels
 * ===================================================================== */
let selected = null, panelSig = '';
function select(sel, opts = {}) {
  selected = sel; panelSig = '';
  stnEls.forEach((e, i) => e.g.classList.toggle('sel', !!(sel && sel.type === 'stn' && sel.id === i)));
  const open = !!sel;
  $('panel').hidden = !open;
  $('app').classList.toggle('panel-open', open);
  if (sel && sel.type === 'stn') {
    const [, x, y] = D.st[sel.id];
    if (opts.fly) flyTo({ s: Math.max(view.s, 0.09), cx: x + (W > 760 ? 180 / Math.max(view.s, .09) : 0), cy: y + (W <= 760 ? H * .22 / Math.max(view.s, .09) : 0) }, 700);
    try { history.replaceState(null, '', '#' + slug(D.st[sel.id][0])); } catch { /* sandboxed */ }
  } else if (!sel) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* sandboxed */ } }
  onView(); renderPanel(true);
  if (open && opts.focus) setTimeout(() => $('close').focus({ preventScroll: true }), 0);
}
const slug = n => short(n).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function setHead(kicker, title, sub, front = '') {
  $('ph-kicker').innerHTML = kicker; $('ph-title').textContent = title; $('ph-sub').textContent = sub;
  const f = $('ph-front');
  if (f.dataset.sig !== front) { f.innerHTML = front; f.dataset.sig = front; }
  f.hidden = !front; f.parentNode.classList.toggle('has-front', !!front);
}

function departures(station, windowMin = 60) {
  const now = nowMs() / 1000, out = [], seen = new Set(), tNow = performance.now();
  for (const c of contexts(nowMs())) {
    for (let i = 0; i < D.trips.length; i++) {
      const t = D.trips[i]; if (!c.svc.has(t[0])) continue;
      const k = profPos[t[1]].get(station); if (k === undefined) continue;
      const seq = D.prof[t[1]][0]; if (k === seq.length - 1) continue;
      const key = i + '@' + c.ds; if (seen.has(key)) continue;
      const rt = RT.trips.get(key) || null;
      const sched = c.base / 1000 + t[2] + D.prof[t[1]][1][2 * k + 1];
      const dly = rt ? currentDelays(rt, tNow) : null;
      const exp = sched + (dly ? dly[k] : 0);
      if (exp < now - 20 || exp > now + windowMin * 60) continue;
      seen.add(key);
      out.push({ i, key, k, sched, exp, d: dly ? dly[k] : null, rt, next: seq[k + 1], line: D.prof[t[1]][2], cancelled: rt && rt.rel === 3, skip: rt && rt.skip.has(k) });
    }
  }
  return out.sort((a, b) => a.exp - b.exp);
}
function whenHTML(o, now) {
  const mins = (o.exp - now) / 60;
  const big = o.cancelled ? 'Cancelled' : mins < 0.75 ? 'Now' : Math.round(mins) + ' min';
  const late = o.d != null && Math.abs(o.d) >= 60;
  return `<span class="when"><b>${big}</b><small>${late ? `<s>${hhmm(o.sched * 1000)}</s> ` : ''}${hhmm(o.exp * 1000)}</small></span>`;
}
function renderStation(id) {
  const now = nowMs() / 1000;
  const name = D.st[id][0];
  const L = stationLines[id];
  const badges = [1, 2].filter(l => L & l).map(l => `<b class="badge sm l${l}">L${l}</b>`).join('');
  setHead(`${badges}<span>Station</span>`, name, departuresSub());
  const deps = departures(id).filter(o => !hidden.has(o.line));
  if (!deps.length) return `<div class="empty">No trains are due here in the next hour.${nightNote()}</div>`;
  // group by the next station (i.e. the platform / direction)
  const groups = new Map();
  for (const o of deps) { const g = groups.get(o.next) || []; g.push(o); groups.set(o.next, g); }
  let html = '';
  for (const [, list] of [...groups].sort((a, b) => a[1][0].exp - b[1][0].exp)) {
    const dests = [...new Set(list.map(o => short(destOf(o.i))))];
    html += `<div class="sect"><span>Towards ${esc(dests.slice(0, 3).join(', '))}</span><span>${esc('via ' + short(D.st[list[0].next][0]))}</span></div><ul class="board">`;
    for (const o of list.slice(0, 8)) {
      const chip = o.rt ? `<span class="dchip ${delayClass(o.d)}">${fmtDelay(o.d)}</span>` : (RT.state === 'live' ? '<span class="dchip sched">Timetable</span>' : '');
      const unit = o.rt && o.rt.v ? ` · unit ${esc(o.rt.v)}` : '';
      html += `<li data-key="${o.key}" class="${o.cancelled ? 'cancel' : ''}${o.exp < now ? ' gone' : ''}"><b class="badge sm l${o.line}">L${o.line}</b><span><span class="dest">${esc(short(destOf(o.i)))}</span>${chip}<span class="meta">${o.skip ? 'Does not stop here' : 'From ' + esc(short(originOf(o.i))) + unit}</span></span>${whenHTML(o, now)}</li>`;
    }
    html += '</ul>';
  }
  return html + alertsFor(id);
}
function departuresSub() {
  if (RT.state === 'live') return 'Departures in the next hour, with live delays';
  if (RT.state === 'stale') return 'Departures in the next hour. Live data is out of date';
  return 'Departures in the next hour, from the timetable';
}
function nightNote() {
  const h = ymd(nowMs()).h;
  return h >= 0 && h < 6 ? ' Metro Bilbao runs all night only on Friday and Saturday nights.' : '';
}
function alertsFor(stationId) {
  if (!RT.alerts.length) return '';
  const ids = new Set(Object.entries(D.stopMap).filter(([, v]) => v === stationId).map(([k]) => k));
  const list = RT.alerts.filter(a => a.stops.some(s => ids.has(s)));
  if (!list.length) return '';
  return '<div class="sect"><span>Alerts for this station</span></div>' + list.map(alertHTML).join('');
}
/*
 * Metro Bilbao CAF units (500, 550 and 600 series share one body design), drawn from reference photos:
 *  - brushed-aluminium body with rounded roof shoulders and dark roof ventilation grilles
 *  - tall, continuous dark glazing; three double sliding doors per side on every car, each doorway
 *    edged with a thin orange-red line; orange-red band along the bottom of the body
 *  - capsule-shaped cab: a thick silver surround framing a black glass face with the destination LED
 *    at the top, windscreen with a single wiper, the Metro Bilbao rings, and small round lamps low down
 *  - 4 cars (72 m), or 5 cars for the 600s; 1500 V overhead line picked up by pantographs.
 */
const BRAND = window.MB_BRAND || null;
const ringsImg = (x, y, w, cls = '') => BRAND ? `<image class="${cls}" href="${BRAND.rings}" x="${x}" y="${y}" width="${w}" height="${(w * BRAND.ringsRatio).toFixed(2)}" preserveAspectRatio="xMidYMid meet"/>` : '';

/** Side view. The right-hand end is the front. Wrapper classes: .moving (wheels, track, headlight) and .open (doors). */
function trainSVG(line, unit, dest, cars) {
  const cw = 124, gap = 5, W0 = cars * cw + (cars - 1) * gap;
  const yT = 22, yB = 80, yW = 30, yWb = 56, rS = 10;    // roof, body bottom, glazing top/bottom, shoulder radius
  const cab = 16;                                          // length of the rounded cab end
  // show the leading two and a bit cars large; the rest of the train runs off the left edge
  const vx = Math.max(-12, W0 - 2.35 * (cw + gap)), vw = W0 + 14 - vx;
  let s = `<svg viewBox="${vx} -2 ${vw} 106" role="img" aria-label="${cars}-car unit${unit ? ' ' + esc(unit) : ''}, destination ${esc(dest)}">`;
  s += `<defs>
    <linearGradient id="u-alu" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="u-a0"/><stop offset=".12" class="u-a1"/><stop offset=".6" class="u-a2"/><stop offset="1" class="u-a3"/></linearGradient>
    <linearGradient id="u-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2A3136"/><stop offset=".5" stop-color="#171C20"/><stop offset="1" stop-color="#0E1215"/></linearGradient>
    <linearGradient id="u-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".16"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
    <linearGradient id="u-inside" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FFF4DA"/><stop offset="1" stop-color="#E9D7B4"/></linearGradient>
    <radialGradient id="u-glow"><stop offset="0" stop-color="#FFF6D6" stop-opacity=".9"/><stop offset="1" stop-color="#FFF6D6" stop-opacity="0"/></radialGradient>
  </defs>`;
  s += `<line class="u-wire" x1="-12" y1="3" x2="${W0 + 14}" y2="3"/>`;
  s += `<g class="u-track">`; for (let x = -30; x < W0 + 34; x += 11) s += `<rect class="u-sleeper" x="${x}" y="96.5" width="6.5" height="3" rx="1"/>`; s += `</g>`;
  s += `<line class="u-rail" x1="-12" y1="95.5" x2="${W0 + 14}" y2="95.5"/>`;
  s += `<g class="u-bodyg">`;
  for (let c = 0; c < cars; c++) {
    const x = c * (cw + gap), xe = x + cw, front = c === cars - 1, rear = c === 0;
    const L = rear ? x + cab : x, R = front ? xe - cab : xe;      // straight part of the body
    // gangway to the next car
    if (!front) s += `<rect class="u-gang" x="${xe - 1}" y="${yW - 1}" width="${gap + 2}" height="${yB - yW - 2}" rx="1"/>`;
    // underframe and bogies first so the body overlaps them
    s += `<rect class="u-under" x="${x + 28}" y="${yB - 1}" width="${cw - 56}" height="7" rx="1.5"/>`;
    for (const k of [0, 1, 2]) s += `<rect class="u-box" x="${x + 34 + k * 20}" y="${yB + 1}" width="13" height="6" rx="1"/>`;
    for (const bx of [x + 20, xe - 20]) {
      s += `<rect class="u-bogie" x="${bx - 15}" y="${yB + 1}" width="30" height="6" rx="2.5"/>`;
      for (const wx of [bx - 8.5, bx + 8.5]) s += `<g class="u-wheelg"><circle class="u-wheel" cx="${wx}" cy="${yB + 9.5}" r="5.8"/><path class="u-spoke" d="M${wx - 4.3} ${yB + 9.5}H${wx + 4.3}M${wx} ${yB + 5.2}V${yB + 13.8}"/><circle class="u-hub" cx="${wx}" cy="${yB + 9.5}" r="1.5"/></g>`;
    }
    // body: rounded roof shoulders; cab ends are capsules with a big top radius
    let d = `M${L + (rear ? 0 : rS)} ${yT}H${R - (front ? 0 : rS)}`;
    d += front ? `C${xe - 5} ${yT} ${xe} ${yT + 7} ${xe} ${yT + 20}V${yB - 5}Q${xe} ${yB} ${xe - 5} ${yB}` : `Q${xe} ${yT} ${xe} ${yT + rS}V${yB - 2}Q${xe} ${yB} ${xe - 2} ${yB}`;
    d += rear ? `H${x + 5}Q${x} ${yB} ${x} ${yB - 5}V${yT + 20}C${x} ${yT + 7} ${x + 5} ${yT} ${L} ${yT}Z` : `H${x + 2}Q${x} ${yB} ${x} ${yB - 2}V${yT + rS}Q${x} ${yT} ${x + rS} ${yT}Z`;
    s += `<path class="u-body" d="${d}" fill="url(#u-alu)"/>`;
    // roof ventilation grilles on the shoulder
    const gx0 = x + (rear ? 26 : 14), gx1 = xe - (front ? 26 : 14);
    s += `<rect class="u-grille" x="${gx0}" y="${yT + .8}" width="${gx1 - gx0}" height="3.2" rx="1.5"/>`;
    let gl = ''; for (let gx = gx0 + 2; gx < gx1 - 1; gx += 2.4) gl += `M${gx} ${yT + 1.3}v2.2`;
    s += `<path class="u-grill" d="${gl}"/>`;
    const pan = cars === 5 ? (c === 1 || c === 3) : (c === 1 || c === 2);
    if (pan) { const px = x + cw / 2 + (c < cars / 2 ? -30 : 30); s += `<g class="u-panto"><rect x="${px - 9}" y="${yT - 2.6}" width="18" height="2.6" rx="1"/><path d="M${px - 7} ${yT - 2}L${px + 8} ${yT - 11}L${px - 3} ${yT - 18.5}M${px - 10} ${yT - 18.5}H${px + 4}"/></g>`; }
    // glazing band: continuous dark glass from end to end of the saloon
    const g0 = rear ? x + cab + 1 : x + 3, g1 = front ? xe - cab - 1 : xe - 3;
    s += `<rect class="u-band" x="${g0}" y="${yW}" width="${g1 - g0}" height="${yWb - yW}" rx="2" fill="url(#u-glass)"/>`;
    s += `<rect class="u-sheen" x="${g0}" y="${yW}" width="${g1 - g0}" height="${yWb - yW}" rx="2" fill="url(#u-sheen)"/>`;
    // three double doors per side
    const pos = front ? [.17, .45, .72] : rear ? [.28, .55, .83] : [.2, .5, .8];
    const dw = 7.5, dTop = yW, dBot = yB - 5;
    for (const f of pos) {
      const dx = x + cw * f;
      s += `<g class="u-doorset"><rect class="u-inside" x="${dx - dw}" y="${dTop}" width="${dw * 2}" height="${dBot - dTop}" fill="url(#u-inside)"/>`
        + `<line class="u-pole" x1="${dx}" y1="${dTop + 2}" x2="${dx}" y2="${dBot - 1}"/>`
        + `<g class="u-door l"><rect class="u-leaf" x="${dx - dw}" y="${dTop}" width="${dw}" height="${dBot - dTop}"/><rect class="u-dglass" x="${dx - dw + 1}" y="${dTop + 1}" width="${dw - 1.6}" height="${yWb - yW - 3}" rx=".8"/></g>`
        + `<g class="u-door r"><rect class="u-leaf" x="${dx}" y="${dTop}" width="${dw}" height="${dBot - dTop}"/><rect class="u-dglass" x="${dx + .6}" y="${dTop + 1}" width="${dw - 1.6}" height="${yWb - yW - 3}" rx=".8"/></g>`
        + `<line class="u-jamb" x1="${dx - dw - .9}" y1="${dTop}" x2="${dx - dw - .9}" y2="${dBot}"/></g>`;
    }
    // side LED destination sign above the first door of each car
    const lx = x + cw * pos[0] - 16;
    s += `<rect class="u-sled" x="${lx}" y="${yW + 1.5}" width="9" height="3" rx=".6"/>`;
    // orange-red band along the bottom of the body
    s += `<path class="u-stripe" d="M${rear ? x + 4 : x + 1} ${yB - 4.5}H${front ? xe - 4 : xe - 1}V${yB - 1}H${rear ? x + 4 : x + 1}Z"/>`;
    // cab ends
    if (front) {
      s += `<path class="u-cabwin" d="M${xe - cab + 1} ${yW}H${xe - 5}C${xe - 2.2} ${yW} ${xe - .9} ${yW + 3} ${xe - .9} ${yW + 7}V${yWb + 4}H${xe - cab + 1}Z"/>`;
      s += `<rect class="u-sideface" x="${xe - 2.6}" y="${yT + 14}" width="2.6" height="${yB - yT - 20}" rx="1.2"/>`;
      s += `<circle class="u-glow" cx="${xe + 3}" cy="${yB - 13}" r="12" fill="url(#u-glow)"/><circle class="u-light" cx="${xe - 1.2}" cy="${yB - 13}" r="1.6"/>`;
      s += ringsImg(xe - cab - 21, yW + 11, 12, 'u-rings');
      if (unit) s += `<text class="u-num" x="${xe - cab - 2}" y="${yT + 5.6}" text-anchor="end">${esc(unit)}</text>`;
    }
    if (rear) {
      s += `<path class="u-cabwin" d="M${x + cab - 1} ${yW}H${x + 5}C${x + 2.2} ${yW} ${x + .9} ${yW + 3} ${x + .9} ${yW + 7}V${yWb + 4}H${x + cab - 1}Z"/>`;
      s += `<rect class="u-sideface" x="${x}" y="${yT + 14}" width="2.6" height="${yB - yT - 20}" rx="1.2"/>`;
      s += `<circle class="u-tail" cx="${x + 1.2}" cy="${yB - 13}" r="1.5"/>`;
    }
  }
  s += `</g>`;
  return s + '</svg>';
}

/** Front view of the cab: the silver "capsule" around a black glass face. */
function frontSVG(line, unit, dest) {
  let s = `<svg viewBox="0 0 64 72" role="img" aria-label="Front of the train">`;
  s += `<defs><linearGradient id="f-alu" x1="0" y1="0" x2="1" y2="0"><stop offset="0" class="u-a3"/><stop offset=".18" class="u-a1"/><stop offset=".5" class="u-a0"/><stop offset=".82" class="u-a1"/><stop offset="1" class="u-a3"/></linearGradient>
    <linearGradient id="f-glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2B3338"/><stop offset=".55" stop-color="#14191C"/><stop offset="1" stop-color="#0B0E10"/></linearGradient></defs>`;
  s += `<path class="f-shell" d="M8 66Q4 66 4 61V22C4 10 12 3 24 3H40C52 3 60 10 60 22V61Q60 66 56 66Z" fill="url(#f-alu)"/>`;
  s += `<rect class="f-grille" x="20" y="4.2" width="24" height="2.4" rx="1.2"/>`;
  s += `<path class="f-face" d="M12 55Q9 55 9 52V23C9 14 15 9 24 9H40C49 9 55 14 55 23V52Q55 55 52 55Z" fill="url(#f-glass)"/>`;
  s += `<rect class="f-led" x="15" y="12" width="34" height="5" rx="1"/>`;
  s += `<text class="f-ledtext" x="32" y="15.9" text-anchor="middle">${esc(dest.toUpperCase().slice(0, 14))}</text>`;
  s += `<path class="f-reflect" d="M14 20L26 20L18 38L12 38Z"/>`;
  s += `<path class="f-wiper" d="M36 39L27 24"/>`;
  s += ringsImg(40, 40, 9);
  s += `<circle class="f-head" cx="15.5" cy="48" r="2"/><circle class="f-head" cx="48.5" cy="48" r="2"/>`;
  s += `<circle class="f-tail" cx="21" cy="48.5" r="1.2"/><circle class="f-tail" cx="43" cy="48.5" r="1.2"/>`;
  s += `<rect class="f-bumper" x="12" y="57" width="40" height="6.5" rx="3"/>`;
  s += `<rect class="f-line l${line}" x="26" y="59.2" width="12" height="2" rx="1"/>`;
  if (unit) s += `<text class="f-num" x="52" y="8" text-anchor="end">${esc(unit)}</text>`;
  return s + '</svg>';
}
let unitWanted = null, unitNode = null, unitSig = '';
function mountUnit() {
  const slot = $('pc').querySelector('.unit-slot');
  if (!slot || !unitWanted) return;
  const w = unitWanted, sig = [w.key, w.line, w.unit, w.dest].join('|');
  if (!unitNode || unitSig !== sig) {
    unitNode = document.createElement('div');
    unitNode.innerHTML = trainSVG(w.line, w.unit, w.dest, carsOf(w.unit));
    unitSig = sig;
  }
  unitNode.className = 'unit ' + (w.dwell ? 'open' : 'moving');
  slot.replaceWith(unitNode);
}
function renderTrain(key) {
  const e = trainEls.get(key);
  const now = nowMs() / 1000, tNow = performance.now();
  if (!e) {
    setHead('<span>Train</span>', 'Service ended', 'This train has reached its terminus or is no longer running.');
    return '<div class="empty">Tap another train or a station.</div>';
  }
  const { a, pos } = e;
  const [, pi, start] = D.trips[a.i], P = D.prof[pi], seq = P[0], line = P[2];
  const dly = a.rt ? currentDelays(a.rt, tNow) : null;
  const dNow = dly ? dly[pos.dwell ? pos.k : pos.next] : null;
  setHead(`<b class="badge sm l${line}">L${line}</b><span>Train ${a.rt && a.rt.v ? esc(a.rt.v) : ''}</span>`, 'To ' + short(destOf(a.i)),
    `From ${short(originOf(a.i))} at ${hhmm((a.ctx.base / 1000 + start) * 1000)}`, frontSVG(line, a.rt && a.rt.v, short(destOf(a.i))));
  const series = a.rt && a.rt.v ? ({ '600 series': '600 series · 5 cars', '550 series': '550 series · 4 cars', '500 series': '500 series · 4–5 cars' })[unitSeries(a.rt.v)] || null : null;
  let html = `<div class="unit-slot"></div>`;
  unitWanted = { key, line, unit: a.rt && a.rt.v, dest: short(destOf(a.i)), dwell: pos.dwell };
  const nextName = short(D.st[seq[pos.dwell ? pos.k : pos.next]][0]);
  html += `<dl class="facts"><div><dt>${pos.dwell ? 'At' : 'Next'}</dt><dd title="${esc(nextName)}">${esc(nextName)}</dd></div>`
    + `<div><dt>Running</dt><dd><span class="dchip ${a.rt ? delayClass(dNow) : 'sched'}" style="margin:0">${a.rt ? fmtDelay(dNow) : 'Timetable'}</span></dd></div>`
    + `<div><dt>Unit</dt><dd>${a.rt && a.rt.v ? esc(a.rt.v) + (series ? `<small style="font-weight:500;color:var(--muted)"> ${series}</small>` : '') : '–'}</dd></div></dl>`;
  html += `<div class="sect"><span>Calling at</span><span>${a.rt ? 'Expected' : 'Timetable'}</span></div><ol class="tl" style="--lc:var(--l${line})">`;
  const cur = pos.dwell ? pos.k : pos.next;
  for (let k = 0; k < seq.length; k++) {
    const [arr] = stopTimes(a.i, a.ctx, a.rt, k, dly);
    const schedArr = a.ctx.base / 1000 + start + P[1][2 * k];
    const past = k < cur || (k === cur && !pos.dwell && false);
    const cls = (past ? 'past' : '') + (pos.dwell && k === pos.k ? ' now' : '') + (a.rt && a.rt.skip.has(k) ? ' skip' : '');
    const showSched = dly && Math.abs(dly[k]) >= 60;
    html += `<li class="${cls}" data-stn="${seq[k]}"><span class="dot"></span><span class="n">${esc(short(D.st[seq[k]][0]))}</span><span class="t">${showSched ? `<s>${hhmm(schedArr * 1000)}</s>` : ''}${hhmm(arr * 1000)}</span></li>`;
  }
  html += '</ol>';
  if (!a.rt) html += `<p class="note">${RT.state === 'live' ? 'The live feed has no prediction for this train, so its position comes from the timetable.' : 'Position estimated from the timetable.'}</p>`;
  return html;
}
function renderList() {
  setHead('<span>Network</span>', 'All trains', `${active.length} trains running now`);
  const tNow = performance.now();
  const rows = [];
  for (const [key, e] of trainEls) {
    const { a, pos } = e; const line = lineOfTrip(a.i);
    if (hidden.has(line)) continue;
    const dly = a.rt ? currentDelays(a.rt, tNow) : null;
    const d = dly ? dly[pos.dwell ? pos.k : pos.next] : null;
    const seq = D.prof[D.trips[a.i][1]][0];
    rows.push({ key, line, d, rt: a.rt, dest: short(destOf(a.i)), at: short(D.st[seq[pos.dwell ? pos.k : pos.next]][0]), dwell: pos.dwell });
  }
  rows.sort((x, y) => (y.d ?? -1e9) - (x.d ?? -1e9) || x.line - y.line);
  if (!rows.length) return `<div class="empty">No trains are running right now.${nightNote()}</div>`;
  return '<ul class="board">' + rows.map(r => `<li data-key="${r.key}"><b class="badge sm l${r.line}">L${r.line}</b><span><span class="dest">${esc(r.dest)}</span><span class="meta">${r.dwell ? 'At' : 'Next'} ${esc(r.at)}${r.rt && r.rt.v ? ' · unit ' + esc(r.rt.v) : ''}</span></span><span class="when"><span class="dchip ${r.rt ? delayClass(r.d) : 'sched'}">${r.rt ? fmtDelay(r.d) : 'Timetable'}</span></span></li>`).join('') + '</ul>';
}
function alertHTML(a) {
  const pick = o => o ? (o.en || o.es || o.eu || Object.values(o)[0] || '') : '';
  const effect = (a.effect || '').replace(/_/g, ' ').toLowerCase();
  return `<div class="alert">${effect && effect !== 'unknown effect' ? `<span class="tag">${esc(effect)}</span>` : ''}<h3>${esc(pick(a.header) || 'Service notice')}</h3><p>${esc(pick(a.description))}</p></div>`;
}
function renderAlerts() {
  setHead('<span>Metro Bilbao</span>', 'Service alerts', `${RT.alerts.length} active notice${RT.alerts.length === 1 ? '' : 's'} from the live feed`);
  return RT.alerts.length ? RT.alerts.map(alertHTML).join('') : '<div class="empty">No service alerts right now.</div>';
}
function renderAbout() {
  const live = RT.data;
  const stateText = { live: 'Live', stale: 'Live data delayed', offline: 'Timetable only', error: 'Live feed unavailable', loading: 'Connecting' }[RT.state];
  setHead('<span>About the data</span>', stateText, SIMULATED ? 'Simulated clock (set with ?at=)' : 'Europe/Madrid time');
  const rows = [];
  if (RT.state === 'offline') rows.push(`<p>This copy of the map has no live connection, so trains are placed from the timetable. Run the included server (<code>node server.js</code>) or deploy it to Vercel to add live delays.</p>`);
  if (live) rows.push(`<p>Predictions for <b>${RT.matched}</b> trips from CTB's GTFS-Realtime feed${RT.unmatched ? `, ${RT.unmatched} not in this timetable` : ''}. Feed generated at <b>${hhmmss(live.feedTime * 1000)}</b>; checked every ${CFG.pollMs / 1000} s.</p>`);
  if (RT.error) rows.push(`<p>Last error: ${esc(RT.error)}</p>`);
  rows.push(`<p>Timetable valid ${fmtDate(D.valid[0])} to ${fmtDate(D.valid[1])} (Metro Bilbao open data). Positions between stations are estimated from the timetable and the live delay at the next station, so they are approximate.</p>`);
  rows.push(`<p>L1 runs Etxebarri – Plentzia along the right bank; L2 runs Basauri – Kabiezes along the left bank. They share the track between Etxebarri and San Ignazio. A few L1 trains start at Basauri.</p>`);
  return `<div class="note" style="font-size:13.5px;color:var(--ink);padding-top:14px">${rows.join('')}</div>`;
}
const fmtDate = ds => ds ? new Date(Date.UTC(+ds.slice(0, 4), ds.slice(4, 6) - 1, +ds.slice(6))).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '?';

function renderPanel(force) {
  if (!selected) return;
  let html;
  if (selected.type === 'stn') html = renderStation(selected.id);
  else if (selected.type === 'train') html = renderTrain(selected.key);
  else if (selected.type === 'list') html = renderList();
  else if (selected.type === 'alerts') html = renderAlerts();
  else html = renderAbout();
  const sig = html + $('ph-title').textContent + $('ph-sub').textContent;
  if (unitNode && unitWanted) unitNode.className = 'unit ' + (unitWanted.dwell ? 'open' : 'moving');
  if (!force && sig === panelSig) { positionTimelineMarker(); return; }
  panelSig = sig;
  const pc = $('pc'), st = pc.scrollTop;
  pc.innerHTML = html;
  mountUnit();
  pc.scrollTop = force ? 0 : st;
  positionTimelineMarker();
  if (force && selected.type === 'train') {
    // bring the train's current stop into view
    const cur = pc.querySelector('.tl li:not(.past)');
    if (cur) pc.scrollTop = Math.max(0, cur.getBoundingClientRect().top - pc.getBoundingClientRect().top - 140);
  }
}
function positionTimelineMarker() {
  if (!selected || selected.type !== 'train') return;
  const e = trainEls.get(selected.key); const tl = $('pc').querySelector('.tl'); if (!e || !tl) return;
  const items = tl.children; const { pos } = e;
  const a = items[pos.k]; const b = items[pos.dwell ? pos.k : pos.next];
  if (!a || !b) return;
  let me = tl.querySelector('.me'); if (!me) { me = document.createElement('span'); me.className = 'me'; tl.appendChild(me); }
  const ya = a.offsetTop + a.offsetHeight / 2, yb = b.offsetTop + b.offsetHeight / 2;
  me.style.top = (ya + (yb - ya) * (pos.dwell ? 0 : pos.f) - 7.5) + 'px';
  [...items].forEach((li, k) => { if (li.tagName === 'LI') li.classList.toggle('past', k < (pos.dwell ? pos.k : pos.next) && !(pos.dwell && k === pos.k)); });
}
$('pc').addEventListener('click', ev => {
  const li = ev.target.closest('li'); if (!li) return;
  if (li.dataset.key) {
    select({ type: 'train', key: li.dataset.key });
    const e = trainEls.get(li.dataset.key);
    if (e) flyTo({ s: Math.max(view.s, 0.12), cx: e.pos.x + (W > 760 ? 180 / Math.max(view.s, .12) : 0), cy: e.pos.y + (W <= 760 ? H * .22 / Math.max(view.s, .12) : 0) }, 700);
  } else if (li.dataset.stn) select({ type: 'stn', id: +li.dataset.stn }, { fly: true });
});
$('close').onclick = () => select(null);

/* ---------- card ---------- */
function renderStatus() {
  const p = $('status');
  const txt = {
    loading: 'Connecting…',
    live: 'Live',
    stale: 'Live · delayed',
    offline: 'Timetable',
    error: 'Live unavailable',
  }[RT.state];
  p.dataset.state = RT.state;
  p.querySelector('span').textContent = txt;
  p.title = RT.state === 'live' ? 'Live delays from CTB GTFS-Realtime' : RT.error || '';
}
function renderAlertsButton() {
  const n = RT.alerts.length; $('alerts-btn').hidden = !n; $('alerts-n').textContent = n;
  const ids = new Set(); RT.alerts.forEach(a => a.stops.forEach(s => { const v = D.stopMap[s]; if (v !== undefined) ids.add(v); }));
  stnEls.forEach((e, i) => e.g.classList.toggle('alert', ids.has(i)));
}
function renderStats(counts) {
  $('c1').textContent = counts[1]; $('c2').textContent = counts[2];
  const tNow = performance.now();
  const ds = [];
  for (const [, e] of trainEls) {
    if (!e.a.rt || hidden.has(lineOfTrip(e.a.i))) continue;
    const dly = currentDelays(e.a.rt, tNow); ds.push(dly[e.pos.dwell ? e.pos.k : e.pos.next]);
  }
  if (!ds.length) { $('s-ontime').textContent = '–'; $('s-avg').textContent = '–'; $('s-late').textContent = '–'; return; }
  const ontime = ds.filter(d => d < 120 && d > -60).length;
  const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
  $('s-ontime').textContent = Math.round(ontime / ds.length * 100) + '%';
  $('s-avg').textContent = fmtDelay(avg).replace('On time', '0:00');
  $('s-late').textContent = ds.filter(d => d >= 180).length;
}
function renderAttribution() {
  const parts = ['Data: <a href="https://www.metrobilbao.eus/es/open-data/dataset" target="_blank" rel="noopener">Metro Bilbao</a>, <a href="https://data.ctb.eus/dataset/metro-bilbao-online" target="_blank" rel="noopener">CTB</a>',
    'Map: Eustat/GeoEuskadi, © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'];
  if (tilesOn) parts.push(CFG.tileAttribution);
  $('attrib').innerHTML = parts.join(' · ');
}
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 5000); }

/* brand: the wordmark swaps to a light version on dark backgrounds */
function setBrand() {
  if (!BRAND) return;
  $('brand-logo').src = isDark() ? BRAND.logoDark : BRAND.logo;
  let icon = document.querySelector('link[rel="icon"]');
  if (icon) icon.href = BRAND.rings;
}

/* line toggles */
document.querySelectorAll('.linechip').forEach(b => {
  const L = +b.dataset.line;
  b.setAttribute('aria-pressed', !hidden.has(L));
  b.onclick = () => {
    if (hidden.has(L)) hidden.delete(L); else hidden.add(L);
    if (hidden.size === 2) hidden.delete(L === 1 ? 2 : 1);
    document.querySelectorAll('.linechip').forEach(x => x.setAttribute('aria-pressed', !hidden.has(+x.dataset.line)));
    safeLS.set('mb-hidden-lines', JSON.stringify([...hidden]));
    panelSig = ''; onView();
  };
});
$('collapse').onclick = () => {
  const c = $('card').classList.toggle('collapsed');
  $('collapse').setAttribute('aria-expanded', !c); $('collapse').setAttribute('aria-label', c ? 'Expand panel' : 'Collapse panel');
};
$('status').onclick = () => select({ type: 'about' });
$('list-btn').onclick = () => select({ type: 'list' });
$('alerts-btn').onclick = () => select({ type: 'alerts' });

/* search */
const q = $('q'), results = $('results'); let resIdx = 0, resList = [];
const fold = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
function renderResults() {
  const v = fold(q.value.trim());
  if (!v) { results.hidden = true; return; }
  resList = D.st.map((s, i) => ({ i, n: s[0] })).filter(o => fold(o.n).includes(v)).sort((a, b) => fold(a.n).indexOf(v) - fold(b.n).indexOf(v)).slice(0, 8);
  resIdx = 0;
  results.innerHTML = resList.length ? resList.map((o, j) => `<li role="option" data-i="${o.i}" aria-selected="${j === 0}">${[1, 2].filter(l => stationLines[o.i] & l).map(l => `<b class="badge sm l${l}">L${l}</b>`).join('')}${esc(o.n)}</li>`).join('') : '<li aria-disabled="true">No station matches</li>';
  results.hidden = false;
}
q.addEventListener('input', renderResults);
q.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); resIdx = clamp(resIdx + (e.key === 'ArrowDown' ? 1 : -1), 0, resList.length - 1); [...results.children].forEach((li, j) => li.setAttribute('aria-selected', j === resIdx)); }
  if (e.key === 'Enter' && resList[resIdx]) { pick(resList[resIdx].i); }
  if (e.key === 'Escape') { q.value = ''; results.hidden = true; }
});
results.addEventListener('click', e => { const li = e.target.closest('li[data-i]'); if (li) pick(+li.dataset.i); });
function pick(i) { q.value = ''; results.hidden = true; q.blur(); select({ type: 'stn', id: i }, { fly: true }); }

/* map controls */
$('zi').onclick = () => zoomAt(1.6, W / 2, H / 2);
$('zo').onclick = () => zoomAt(1 / 1.6, W / 2, H / 2);
$('fit').onclick = () => fitNetwork(true);
$('tiles-btn').onclick = () => setTiles(!tilesOn);

/* =====================================================================
 * Pointer & keyboard interaction
 * ===================================================================== */
const ptrs = new Map(); let pinch = null, dragMoved = 0;
svg.addEventListener('pointerdown', e => {
  ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 1) dragMoved = 0;
  svg.classList.add('drag'); flight = null;
});
svg.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  if (ptrs.size === 1) {
    const dx = e.clientX - prev[0], dy = e.clientY - prev[1];
    dragMoved += Math.abs(dx) + Math.abs(dy);
    view.cx -= dx / view.s; view.cy -= dy / view.s; constrain(); onView();
  } else if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const r = svg.getBoundingClientRect();
    if (pinch) zoomAt(d / pinch, (a[0] + b[0]) / 2 - r.left, (a[1] + b[1]) / 2 - r.top);
    pinch = d; dragMoved = 99;
  }
});
const endPtr = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) svg.classList.remove('drag'); };
['pointerup', 'pointercancel', 'pointerleave'].forEach(t => svg.addEventListener(t, endPtr));
svg.addEventListener('wheel', e => { e.preventDefault(); flight = null; const r = svg.getBoundingClientRect(); zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
svg.addEventListener('click', () => { if (dragMoved < 6 && selected && W > 760) { /* keep panel on desktop */ } });
svg.addEventListener('dblclick', e => { const r = svg.getBoundingClientRect(); zoomAt(2, e.clientX - r.left, e.clientY - r.top); });
addEventListener('keydown', e => {
  if (e.target.matches('input')) return;
  if (e.key === 'Escape') select(null);
  const step = 80;
  if (e.key === 'ArrowLeft') { view.cx -= step / view.s; constrain(); onView(); }
  if (e.key === 'ArrowRight') { view.cx += step / view.s; constrain(); onView(); }
  if (e.key === 'ArrowUp' && !e.target.closest('#panel')) { view.cy -= step / view.s; constrain(); onView(); }
  if (e.key === 'ArrowDown' && !e.target.closest('#panel')) { view.cy += step / view.s; constrain(); onView(); }
  if (e.key === '+' || e.key === '=') zoomAt(1.4, W / 2, H / 2);
  if (e.key === '-') zoomAt(1 / 1.4, W / 2, H / 2);
});
addEventListener('resize', () => { computeLimits(); constrain(); onView(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { onView(); setBrand(); });
new MutationObserver(() => { onView(); setBrand(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

/* =====================================================================
 * Main loop
 * ===================================================================== */
let lastSec = -1, lastActive = 0, lastPanel = 0;
function frame(t) {
  stepFlight(t);
  if (viewDirty) applyView();
  const ms = nowMs();
  if (t - lastActive > 1000) { refreshActive(); lastActive = t; }
  const counts = updateTrains(t);
  const sec = Math.floor(ms / 1000);
  if (sec !== lastSec) {
    lastSec = sec;
    const p = partsAt(ms);
    $('clock').innerHTML = `${p.hour}:${p.minute}<span>:${p.second}</span>`;
    renderStats(counts);
  }
  if (t - lastPanel > 1000) { renderPanel(false); lastPanel = t; }
  else if (selected && selected.type === 'train') positionTimelineMarker();
  requestAnimationFrame(frame);
}

async function start() {
  try {
    [D, BM] = await Promise.all([loadTimetable(), loadBasemap()]);
  } catch (e) {
    document.body.insertAdjacentHTML('beforeend', `<div class="empty" style="position:fixed;inset:auto 16px 16px;background:var(--paper);border-radius:12px">Could not load the timetable. ${esc(e.message)}</div>`);
    return;
  }
  prepare();
  M = MBCore.createModel(D);
  setBrand();
  drawBasemap();
  computeLimits();
  buildStations();
  const tilesAvailable = !STANDALONE && CFG.tiles && BM;
  $('tiles-btn').hidden = !tilesAvailable;
  if (tilesAvailable) setTiles(safeLS.get('mb-tiles') !== '0'); else renderAttribution();
  fitNetwork(false);
  renderStatus();
  // timetable validity
  const today = ymd(nowMs()).ds;
  if (D.valid && D.valid[1] && today > D.valid[1]) toast(`This timetable ended on ${fmtDate(D.valid[1])}. Positions may be wrong until it is refreshed.`);
  if (SIMULATED) toast('Simulated clock: ' + hhmm(nowMs()) + (speed !== 1 ? ` at ${speed}× speed` : ''));
  // deep link: #abando
  const h = location.hash.slice(1);
  if (h) { const i = D.st.findIndex(s => slug(s[0]) === h); if (i >= 0) select({ type: 'stn', id: i }, { fly: true, focus: false }); }
  refreshActive();
  requestAnimationFrame(frame);
  await pollLive();
  refreshActive();
  if (!STANDALONE && RT.state !== 'offline') setInterval(pollLive, CFG.pollMs);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && RT.state !== 'offline') pollLive(); });
}
start();
window.__MB = { get D() { return D; }, get RT() { return RT; }, get active() { return active; }, view, select, nowMs, contexts, delaysFor, trainPosition };
})();
