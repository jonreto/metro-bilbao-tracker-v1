'use strict';
/*
 * Builds the compact timetable the front end uses, from a Metro Bilbao GTFS feed.
 *
 *   const { buildTimetable } = require('./timetable');
 *   const tt = buildTimetable(filesByName);   // { 'stops.txt': Buffer|string, ... }
 *
 * Coordinates are Web Mercator metres relative to ORIGIN (y grows downwards), rounded to 1 m,
 * so they line up with the Bizkaia basemap and with standard map tiles.
 */

const ORIGIN = { lon: -2.95, lat: 43.28 };
const R = 6378137;
const X0 = R * ORIGIN.lon * Math.PI / 180;
const Y0 = R * Math.log(Math.tan(Math.PI / 4 + ORIGIN.lat * Math.PI / 360));
function project(lon, lat) {
  return [
    Math.round(R * lon * Math.PI / 180 - X0),
    Math.round(-(R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) - Y0)),
  ];
}

/* ---------- line definitions ----------
 * Metro Bilbao is a "Y":
 *   L1  Etxebarri – San Ignazio – (right bank / Uribe Kosta) – Plentzia
 *   L2  Basauri – Ariz – Etxebarri – San Ignazio – (left bank / Ezkerraldea) – Kabiezes
 * Etxebarri–San Ignazio is the shared trunk. A train's line is decided by the branch it serves
 * beyond San Ignazio, NOT by whether it calls at Basauri: some L1 trains start at Basauri.
 */
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split('/')[0].trim();
const L1_BRANCH = ['lutxana', 'erandio', 'astrabudua', 'leioa', 'lamiako', 'areeta', 'gobela', 'neguri', 'aiboa',
  'algorta', 'bidezabal', 'ibarbengoa', 'berango', 'larrabasterra', 'sopela', 'urduliz', 'plentzia'];
const L2_BRANCH = ['gurutzeta', 'ansio', 'barakaldo', 'bagatza', 'urbinaga', 'sestao', 'abatxolo', 'portugalete',
  'penota', 'santurtzi', 'kabiezes'];
const L2_ONLY_SOUTH = ['basauri', 'ariz'];
const TRUNK = ['etxebarri', 'bolueta', 'basarrate', 'santutxu', 'zazpikaleak', 'abando', 'moyua', 'indautxu',
  'santimami', 'deustu', 'sarriko', 'san ignazio'];
const KNOWN = new Set([...L1_BRANCH, ...L2_BRANCH, ...L2_ONLY_SOUTH, ...TRUNK]);

function lineOf(names) {
  const n = names.map(norm);
  if (n.some(x => L2_BRANCH.includes(x))) return 2;
  if (n.some(x => L1_BRANCH.includes(x))) return 1;
  // trunk-only short workings: Basauri/Ariz ones are L2 duties, the rest L1
  return n.some(x => L2_ONLY_SOUTH.includes(x)) ? 2 : 1;
}

/* ---------- CSV ---------- */
function parseCSV(text) {
  if (Buffer.isBuffer(text)) text = text.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift().map(h => h.trim());
  return rows.map(r => { const o = {}; head.forEach((h, i) => { o[h] = (r[i] || '').trim(); }); return o; });
}
const t2s = t => { const [h, m, s] = t.split(':').map(Number); return h * 3600 + m * 60 + (s || 0); };

/* Douglas–Peucker in metres */
function simplify(pts, tol) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const st = [[0, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); const [x1, y1] = pts[a], [x2, y2] = pts[b];
    const dx = x2 - x1, dy = y2 - y1, L = Math.hypot(dx, dy); let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = L < 1e-9 ? Math.hypot(pts[i][0] - x1, pts[i][1] - y1) : Math.abs(dy * pts[i][0] - dx * pts[i][1] + x2 * y1 - y2 * x1) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function buildTimetable(files, { warn = console.warn } = {}) {
  const get = n => { if (!files[n]) throw new Error(`GTFS is missing ${n}`); return parseCSV(files[n]); };
  const stops = get('stops.txt'), trips = get('trips.txt'), stopTimes = get('stop_times.txt');
  const calendar = files['calendar.txt'] ? get('calendar.txt') : [];
  const calDates = files['calendar_dates.txt'] ? get('calendar_dates.txt') : [];
  const shapes = files['shapes.txt'] ? get('shapes.txt') : [];

  const byId = new Map(stops.map(s => [s.stop_id, s]));
  const parentOf = id => { const s = byId.get(id); return s && s.parent_station ? s.parent_station : id; };

  // group stop_times
  const byTrip = new Map();
  for (const r of stopTimes) {
    let a = byTrip.get(r.trip_id); if (!a) byTrip.set(r.trip_id, a = []);
    a.push(r);
  }

  const svcList = [...new Set(trips.map(t => t.service_id))].sort();
  const svcIdx = new Map(svcList.map((s, i) => [s, i]));
  const usedStations = new Set();
  const profKey = new Map(), profiles = [], outTrips = [];

  for (const t of trips) {
    const rows = (byTrip.get(t.trip_id) || []).sort((a, b) => +a.stop_sequence - +b.stop_sequence);
    if (rows.length < 2) continue;
    const seq = rows.map(r => parentOf(r.stop_id));
    seq.forEach(s => usedStations.add(s));
    const start = t2s(rows[0].departure_time || rows[0].arrival_time);
    const times = [];
    for (const r of rows) times.push(t2s(r.arrival_time || r.departure_time) - start, t2s(r.departure_time || r.arrival_time) - start);
    const key = seq.join(',') + '|' + times.join(',') + '|' + t.shape_id;
    let pi = profKey.get(key);
    if (pi === undefined) { pi = profiles.length; profKey.set(key, pi); profiles.push({ seq, times, shape: t.shape_id }); }
    const id = /^\d+$/.test(t.trip_id) && t.trip_id.length < 16 ? Number(t.trip_id) : t.trip_id;
    outTrips.push([svcIdx.get(t.service_id), pi, start, id]);
  }

  // stations (parent level)
  const nameOf = id => (byId.get(id) || {}).stop_name || id;
  const stationIds = [...usedStations].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'es'));
  const sIdx = new Map(stationIds.map((s, i) => [s, i]));
  const st = stationIds.map(id => {
    const s = byId.get(id);
    const [x, y] = project(parseFloat(s.stop_lon), parseFloat(s.stop_lat));
    return [s.stop_name.trim(), x, y];
  });
  for (const [name] of st) if (!KNOWN.has(norm(name))) warn(`timetable: unknown station "${name}" — check the L1/L2 lists in lib/timetable.js`);
  // every stop id (platform or parent) → station index, for matching GTFS-RT stop_ids
  const stopMap = {};
  for (const s of stops) { const p = parentOf(s.stop_id); if (sIdx.has(p)) stopMap[s.stop_id] = sIdx.get(p); }

  // profiles → compact form + line
  const prof = profiles.map(p => {
    const seq = p.seq.map(s => sIdx.get(s));
    return [seq, p.times, lineOf(seq.map(i => st[i][0]))];
  });

  // geometry: cut shapes into station-to-station segments
  const shp = new Map();
  for (const r of shapes) {
    let a = shp.get(r.shape_id); if (!a) shp.set(r.shape_id, a = []);
    a.push([+r.shape_pt_sequence, project(parseFloat(r.shape_pt_lon), parseFloat(r.shape_pt_lat))]);
  }
  for (const a of shp.values()) a.sort((x, y) => x[0] - y[0]);
  const seg = {};
  const seqsByShape = new Map();
  profiles.forEach((p, i) => {
    let s = seqsByShape.get(p.shape); if (!s) seqsByShape.set(p.shape, s = new Map());
    s.set(prof[i][0].join(','), prof[i][0]);
  });
  for (const [shapeId, seqs] of seqsByShape) {
    const pts = (shp.get(shapeId) || []).map(x => x[1]);
    for (const seqArr of seqs.values()) {
      if (!pts.length) continue;
      const idx = []; let lo = 0;
      for (const s of seqArr) {
        const [sx, sy] = [st[s][1], st[s][2]]; let best = lo, bd = Infinity;
        for (let i = lo; i < pts.length; i++) { const d = (pts[i][0] - sx) ** 2 + (pts[i][1] - sy) ** 2; if (d < bd) { bd = d; best = i; } }
        idx.push(best); lo = best;
      }
      for (let k = 0; k + 1 < seqArr.length; k++) {
        const a = seqArr[k], b = seqArr[k + 1], key = `${a}-${b}`, rkey = `${b}-${a}`;
        if (seg[key] || seg[rkey]) continue;
        const poly = [[st[a][1], st[a][2]], ...pts.slice(idx[k] + 1, idx[k + 1]), [st[b][1], st[b][2]]];
        seg[key] = simplify(poly, 2.5).flat();
      }
    }
  }

  // which line each track segment belongs to, from the canonical full-length patterns
  const segLine = {};
  // canonical pattern = the most-run stopping pattern of each line (Etxebarri–Plentzia, Basauri–Kabiezes)
  const tripsPerProf = new Array(prof.length).fill(0);
  outTrips.forEach(t => tripsPerProf[t[1]]++);
  const canon = line => {
    const count = new Map();
    prof.forEach((p, i) => {
      if (p[2] !== line) return;
      const k = p[0][0] < p[0][p[0].length - 1] ? p[0].join(',') : [...p[0]].reverse().join(',');
      count.set(k, (count.get(k) || 0) + tripsPerProf[i]);
    });
    let best = null, bc = -1;
    for (const [k, c] of count) if (c > bc) { bc = c; best = k; }
    return best ? best.split(',').map(Number) : [];
  };
  for (const line of [1, 2]) {
    const s = canon(line);
    for (let k = 0; k + 1 < s.length; k++) {
      const key = seg[`${s[k]}-${s[k + 1]}`] ? `${s[k]}-${s[k + 1]}` : `${s[k + 1]}-${s[k]}`;
      segLine[key] = (segLine[key] || 0) | line;
    }
  }
  for (const k in seg) if (!segLine[k]) segLine[k] = 0; // used only by unusual workings: drawn neutral

  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const cal = calendar.filter(c => svcIdx.has(c.service_id)).map(c => [svcIdx.get(c.service_id), days.map(d => +c[d]), c.start_date, c.end_date]);
  const cd = calDates.filter(c => svcIdx.has(c.service_id)).map(c => [svcIdx.get(c.service_id), c.date, +c.exception_type]);
  const allDates = [...cal.flatMap(c => [c[2], c[3]]), ...cd.map(c => c[1])].sort();

  return {
    v: 2,
    built: new Date().toISOString(),
    valid: [allDates[0] || null, allDates[allDates.length - 1] || null],
    origin: ORIGIN,
    svc: svcList, cal, cd, st, stopMap, seg, segLine, prof, trips: outTrips,
  };
}

module.exports = { buildTimetable, parseCSV, lineOf, project, ORIGIN };
