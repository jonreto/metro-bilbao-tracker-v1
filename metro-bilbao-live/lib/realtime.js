'use strict';
/*
 * Polls the Bizkaia Transport Consortium (CTB) GTFS-Realtime feeds for Metro Bilbao and
 * turns them into one small JSON document for the front end.
 *
 * Feeds (dataset "metro-bilbao-online" on https://data.ctb.eus):
 *   trip updates      – predicted arrival time per station for every running trip (and the unit's next trips)
 *   vehicle positions – sparse; usually only a few trains
 *   service alerts    – incidents, works, lift outages…
 * The S3 bucket sends no CORS headers, so browsers can't read it directly; this module runs server-side.
 */
const { decode } = require('./gtfsrt');

const BASE = process.env.CTB_RT_BASE || 'https://ctb-gtfs-rt.s3.eu-south-2.amazonaws.com/metro-bilbao-';
const FEEDS = {
  tripUpdates: BASE + 'trip-updates.pb',
  vehicles: BASE + 'vehicle-positions.pb',
  alerts: BASE + 'service-alerts.pb',
};
const TTL_MS = +(process.env.RT_TTL_MS || 12000);
const TIMEOUT_MS = 8000;

const EFFECT = ['', 'NO_SERVICE', 'REDUCED_SERVICE', 'SIGNIFICANT_DELAYS', 'DETOUR', 'ADDITIONAL_SERVICE',
  'MODIFIED_SERVICE', 'OTHER_EFFECT', 'UNKNOWN_EFFECT', 'STOP_MOVED', 'NO_EFFECT', 'ACCESSIBILITY_ISSUE'];
const CAUSE = ['', 'UNKNOWN_CAUSE', 'OTHER_CAUSE', 'TECHNICAL_PROBLEM', 'STRIKE', 'DEMONSTRATION', 'ACCIDENT',
  'HOLIDAY', 'WEATHER', 'MAINTENANCE', 'CONSTRUCTION', 'POLICE_ACTIVITY', 'MEDICAL_EMERGENCY'];

const cache = {}; // per feed: { etag, lastModified, msg, fetchedAt, error }

async function fetchFeed(name, fetchImpl = fetch) {
  const c = cache[name] || (cache[name] = {});
  const headers = {};
  if (c.etag) headers['If-None-Match'] = c.etag;
  if (c.lastModified) headers['If-Modified-Since'] = c.lastModified;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetchImpl(FEEDS[name], { headers, signal: ctl.signal });
    if (r.status === 304 && c.msg) { c.fetchedAt = Date.now(); c.error = null; return c; }
    if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`);
    const buf = new Uint8Array(await r.arrayBuffer());
    c.msg = decode(buf);
    c.etag = r.headers.get('etag'); c.lastModified = r.headers.get('last-modified');
    c.fetchedAt = Date.now(); c.error = null;
  } catch (e) {
    c.error = String(e && e.name === 'AbortError' ? `${name}: timed out` : e.message || e);
  } finally { clearTimeout(timer); }
  return c;
}

const pickText = ts => {
  if (!ts || !ts.translation) return null;
  const o = {};
  for (const t of ts.translation) o[(t.language || 'und').toLowerCase().slice(0, 2)] = t.text;
  return o;
};

function summarise() {
  const tu = cache.tripUpdates && cache.tripUpdates.msg;
  const vp = cache.vehicles && cache.vehicles.msg;
  const al = cache.alerts && cache.alerts.msg;
  const trips = {};
  for (const e of (tu && tu.entity) || []) {
    const u = e.trip_update; if (!u || !u.trip || !u.trip.trip_id) continue;
    trips[u.trip.trip_id] = {
      v: u.vehicle && (u.vehicle.label || u.vehicle.id) || null,
      ts: u.timestamp || null,
      rel: u.trip.schedule_relationship || 0,          // 3 = CANCELED
      d: u.delay ?? null,                               // trip-level delay, if the feed sends it
      dir: u.trip.direction_id ?? null,
      date: u.trip.start_date || null,
      u: (u.stop_time_update || []).map(s => [
        s.stop_id || null,
        s.stop_sequence ?? null,
        s.arrival ? (s.arrival.time ?? null) : null,
        s.arrival ? (s.arrival.delay ?? null) : null,
        s.departure ? (s.departure.time ?? null) : null,
        s.departure ? (s.departure.delay ?? null) : null,
        s.schedule_relationship || 0,                   // 1 = SKIPPED
      ]),
    };
  }
  const vehicles = [];
  for (const e of (vp && vp.entity) || []) {
    const v = e.vehicle; if (!v) continue;
    vehicles.push({
      trip: v.trip && v.trip.trip_id || null,
      id: v.vehicle && (v.vehicle.label || v.vehicle.id) || null,
      lat: v.position && v.position.latitude, lon: v.position && v.position.longitude,
      stop: v.stop_id || null, status: v.current_status ?? null, ts: v.timestamp || null,
    });
  }
  const alerts = [];
  for (const e of (al && al.entity) || []) {
    const a = e.alert; if (!a) continue;
    alerts.push({
      id: e.id,
      header: pickText(a.header_text), description: pickText(a.description_text), url: pickText(a.url),
      cause: CAUSE[a.cause] || null, effect: EFFECT[a.effect] || null,
      periods: (a.active_period || []).map(p => [p.start || null, p.end || null]),
      stops: (a.informed_entity || []).map(x => x.stop_id).filter(Boolean),
      routes: (a.informed_entity || []).map(x => x.route_id).filter(Boolean),
      trips: (a.informed_entity || []).map(x => x.trip && x.trip.trip_id).filter(Boolean),
    });
  }
  const errors = Object.values(cache).map(c => c.error).filter(Boolean);
  return {
    ok: !!tu,
    source: 'CTB GTFS-Realtime (data.ctb.eus/dataset/metro-bilbao-online)',
    now: Math.floor(Date.now() / 1000),
    feedTime: tu && tu.header && tu.header.timestamp || null,
    fetchedAt: cache.tripUpdates && cache.tripUpdates.fetchedAt ? Math.floor(cache.tripUpdates.fetchedAt / 1000) : null,
    trips, vehicles, alerts, errors,
  };
}

let inflight = null, lastRefresh = 0;
/** Returns the live summary, refreshing the feeds if the cache is older than TTL. Concurrent calls share one refresh. */
async function getLive({ fetchImpl } = {}) {
  if (Date.now() - lastRefresh > TTL_MS) {
    if (!inflight) {
      inflight = Promise.all(Object.keys(FEEDS).map(n => fetchFeed(n, fetchImpl)))
        .finally(() => { lastRefresh = Date.now(); inflight = null; });
    }
    await inflight;
  }
  return summarise();
}

module.exports = { getLive, FEEDS, _cache: cache };
