'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'), path = require('path');
const { decode } = require('../lib/gtfsrt');
const Core = require('../public/core.js');
const TT = require('../public/timetable.json');
const M = Core.createModel(TT);
const at = (y, mo, d, h, mi) => Core.madridEpoch(y, mo, d, h, mi);
const tripIdx = new Map(TT.trips.map((t, i) => [String(t[3]), i]));

test('Madrid time conversion handles summer time and the October change', () => {
  assert.equal(new Date(at(2026, 9, 27, 0, 26)).toISOString(), '2026-09-26T22:26:00.000Z');   // CEST
  assert.equal(new Date(at(2026, 10, 26, 12, 0)).toISOString(), '2026-10-26T11:00:00.000Z');  // CET after 25 Oct
});

test('after midnight, trains come from yesterday\'s service (the upstream bug)', () => {
  const sat2350 = M.activeTrips(at(2026, 9, 26, 23, 50)).length;
  const sun0026 = M.activeTrips(at(2026, 9, 27, 0, 26));
  const sun1200 = M.activeTrips(at(2026, 9, 27, 12, 0)).length;
  assert.ok(sat2350 > 5, 'Saturday 23:50 has trains');
  assert.ok(sun0026.length > 5, 'Sunday 00:26 has trains (' + sun0026.length + ')');
  assert.ok(sun0026.every(a => a.ctx.ds === '20260926'), 'all of them belong to Saturday\'s service day');
  assert.ok(sun1200 > 10);
});

test('weekday rush hour shows both lines running', () => {
  const act = M.activeTrips(at(2026, 10, 1, 8, 15));
  const l1 = act.filter(a => TT.prof[TT.trips[a.i][1]][2] === 1).length, l2 = act.length - l1;
  assert.ok(l1 > 8 && l2 > 8, `L1 ${l1}, L2 ${l2}`);
});

test('calendar_dates exceptions swap services (12 Oct holiday uses the festive timetable)', () => {
  const svc = [...M.servicesOn('20261012', 0)].map(i => TT.svc[i]);
  assert.deepEqual(svc, ['obranegvia1_festinvl_26.pex']);
});

test('nothing runs after the feed expires', () => {
  assert.equal(M.activeTrips(at(2026, 11, 3, 12, 0)).length, 0);
});

function liveRow(e) {
  const u = e.trip_update;
  return { v: u.vehicle && u.vehicle.id, rel: 0, u: u.stop_time_update.map(s => [s.stop_id, s.stop_sequence ?? null, s.arrival ? s.arrival.time : null, null, null, null, 0]) };
}
const feed = decode(fs.readFileSync(path.join(__dirname, 'fixtures', 'metro-bilbao-trip-updates.pb')));
const ctxSat = M.contexts(at(2026, 9, 27, 0, 42)).find(c => c.ds === '20260926');

test('live delays are computed per stop against the right service day', () => {
  const e = feed.entity.find(x => x.trip_update.trip.trip_id === '878384');
  const r = M.delaysFor(tripIdx.get('878384'), liveRow(e), ctxSat);
  const k = n => TT.prof[TT.trips[tripIdx.get('878384')][1]][0].indexOf(TT.st.findIndex(s => s[0].startsWith(n)));
  assert.equal(r.d[k('Gurutzeta')], 32);   // 00:42:10 predicted vs 24:41:38 scheduled
  assert.equal(r.d[k('Ansio')], 22);
  assert.equal(r.d[0], 32);                // already-passed stops take the first prediction's delay
});

test('an inconsistent prediction (Gobela after Sopela) is discarded', () => {
  const e = feed.entity.find(x => x.trip_update.trip.trip_id === '878456');
  const r = M.delaysFor(tripIdx.get('878456'), liveRow(e), ctxSat);
  assert.equal(r.dropped, 1);
  assert.ok(Math.max(...r.d) < 60, 'no stop inherits the bogus +18 min');
});

test('a delayed train stays active past its scheduled arrival', () => {
  const i = tripIdx.get('878384');
  const d = new Float64Array(TT.prof[TT.trips[i][1]][0].length).fill(600);
  const [, end] = M.tripWindow(i, ctxSat, null);
  const rt = new Map([[i + '@20260926', { d, rel: 0 }]]);
  const t = (end + 300) * 1000;
  assert.ok(!M.activeTrips(t).some(a => a.i === i), 'on schedule it has finished');
  assert.ok(M.activeTrips(t, rt).some(a => a.i === i), '10 min late it is still running');
  rt.get(i + '@20260926').rel = 3;
  assert.ok(!M.activeTrips(t, rt).some(a => a.i === i), 'cancelled trips are hidden');
});
