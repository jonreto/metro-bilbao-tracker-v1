/* Metro Bilbao Live — timetable and delay model. No DOM; runs in the browser (window.MBCore) and in Node (tests).
 *
 * Service days: GTFS times run past 24:00 (a train at 00:26 on Sunday belongs to Saturday's service and is
 * written 24:26:00). At any moment trains can belong to today's OR yesterday's service, so every query looks at
 * both "contexts". Times are measured from noon − 12 h in Europe/Madrid, which is how GTFS defines a service day
 * (it differs from midnight on the two DST change days).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.MBCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TZ = 'Europe/Madrid';
  const fmtParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const pad2 = n => String(n).padStart(2, '0');

  function partsAt(ms) { const p = {}; for (const x of fmtParts.formatToParts(new Date(ms))) p[x.type] = x.value; if (p.hour === '24') p.hour = '00'; return p; }
  function tzOffset(ms) { const p = partsAt(ms); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - (ms - ((ms % 1000) + 1000) % 1000); }
  /** epoch ms of a Madrid wall-clock time */
  function madridEpoch(y, m, d, h = 0, mi = 0, s = 0) {
    const guess = Date.UTC(y, m - 1, d, h, mi, s);
    let e = guess - tzOffset(guess);
    e = guess - tzOffset(e);
    return e;
  }
  function ymd(ms) { const p = partsAt(ms); return { y: +p.year, m: +p.month, d: +p.day, ds: p.year + p.month + p.day, h: +p.hour, mi: +p.minute, s: +p.second }; }
  function shiftDay(y, m, d, k) { const t = new Date(Date.UTC(y, m - 1, d + k)); return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: (t.getUTCDay() + 6) % 7 }; }

  /** longest run of predictions whose times increase along the route; drops inconsistent ones */
  function consistent(points) {
    const n = points.length; if (n < 3) return points;
    const len = new Array(n).fill(1), prev = new Array(n).fill(-1);
    for (let i = 0; i < n; i++) for (let j = 0; j < i; j++)
      if (points[j].t <= points[i].t + 20 && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    let bi = 0; for (let i = 1; i < n; i++) if (len[i] > len[bi]) bi = i;
    const out = []; for (let i = bi; i >= 0; i = prev[i]) out.push(points[i]);
    return out.reverse();
  }

  function createModel(D) {
    const svcCache = new Map(), ctxCache = new Map();
    function servicesOn(ds, dow) {
      if (svcCache.has(ds)) return svcCache.get(ds);
      const s = new Set();
      for (const [i, days, a, b] of D.cal) if (days[dow] && ds >= a && ds <= b) s.add(i);
      for (const [i, d, t] of D.cd) if (d === ds) { if (t === 1) s.add(i); else s.delete(i); }
      svcCache.set(ds, s); return s;
    }
    /** Service days that can have trains running at `ms`: today and yesterday. */
    function contexts(ms) {
      const t = ymd(ms);
      return [0, -1].map(k => {
        const d = shiftDay(t.y, t.m, t.d, k);
        const ds = d.y + pad2(d.m) + pad2(d.d);
        let c = ctxCache.get(ds);
        if (!c) {
          const base = madridEpoch(d.y, d.m, d.d, 12) - 43200e3;
          c = { ds, dow: d.dow, base, svc: servicesOn(ds, d.dow) };
          ctxCache.set(ds, c);
        }
        return c;
      });
    }
    /**
     * Per-stop delays (s) for trip i from a live trip update, relative to service day ctx.
     * info.u rows: [stop_id, stop_sequence, arrival_time, arrival_delay, departure_time, departure_delay, schedule_relationship]
     * Stops before the first prediction take its delay; gaps are interpolated; after the last, its delay carries on.
     */
    function delaysFor(i, info, ctx) {
      const [, pi, start] = D.trips[i], P = D.prof[pi], seq = P[0], tm = P[1], n = seq.length;
      const pts = []; let lastK = -1; const skip = new Set();
      for (const u of info.u || []) {
        const [stopId, seqNo, at, ad, dt, dd, sr] = u;
        let s = D.stopMap[stopId]; if (s === undefined && stopId) s = D.stopMap[String(stopId).split('.')[0]];
        let k = -1;
        if (seqNo != null && seqNo >= 1 && seqNo <= n && seq[seqNo - 1] === s) k = seqNo - 1;
        else if (s !== undefined) { for (let q = lastK + 1; q < n; q++) if (seq[q] === s) { k = q; break; } if (k < 0) k = seq.indexOf(s); }
        if (k < 0) continue;
        if (sr === 1) { skip.add(k); continue; }
        const schedArr = ctx.base / 1000 + start + tm[2 * k], schedDep = ctx.base / 1000 + start + tm[2 * k + 1];
        let d = null, t = null;
        if (at != null) { d = at - schedArr; t = at; }
        else if (ad != null) { d = ad; t = schedArr + ad; }
        else if (dt != null) { d = dt - schedDep; t = dt; }
        else if (dd != null) { d = dd; t = schedDep + dd; }
        if (d == null) continue;
        pts.push({ k, d, t }); lastK = k;
      }
      if (!pts.length && info.d != null) pts.push({ k: 0, d: info.d, t: 0 });
      pts.sort((a, b) => a.k - b.k);
      const good = consistent(pts);
      if (!good.length) return null;
      const d = new Float64Array(n);
      let j = 0;
      for (let k = 0; k < n; k++) {
        while (j + 1 < good.length && good[j + 1].k <= k) j++;
        const a = good[j], b = good[j + 1];
        if (k <= good[0].k) d[k] = good[0].d;
        else if (!b || k >= good[good.length - 1].k) d[k] = good[good.length - 1].d;
        else d[k] = a.d + (b.d - a.d) * (k - a.k) / (b.k - a.k);
      }
      const med = [...good].sort((x, y) => x.d - y.d)[good.length >> 1].d;
      return { d, skip, med, used: good.length, dropped: pts.length - good.length };
    }
    /** [start, end] epoch seconds of a trip, delays applied */
    function tripWindow(i, ctx, rt) {
      const [, pi, start] = D.trips[i], tm = D.prof[pi][1];
      const b = ctx.base / 1000 + start, d = rt ? rt.d : null;
      return [b + tm[0] + (d ? d[0] : 0), b + tm[tm.length - 1] + (d ? d[d.length - 1] : 0)];
    }
    /** Adjusted [arrival, departure] epoch seconds at stop k */
    function stopTimes(i, ctx, k, dly) {
      const [, pi, start] = D.trips[i], tm = D.prof[pi][1];
      const b = ctx.base / 1000 + start, d = dly ? dly[k] : 0;
      const arr = b + tm[2 * k] + d;
      return [arr, Math.max(arr, b + tm[2 * k + 1] + d)];
    }
    /** Trips running at `ms`. rtMap: key `${i}@${serviceDate}` → {d, rel}. Cancelled trips are left out. */
    function activeTrips(ms, rtMap = new Map()) {
      const now = ms / 1000, out = [], seen = new Set();
      for (const c of contexts(ms)) {
        for (let i = 0; i < D.trips.length; i++) {
          if (!c.svc.has(D.trips[i][0])) continue;
          const key = i + '@' + c.ds; if (seen.has(key)) continue;
          const rt = rtMap.get(key) || null;
          if (rt && rt.rel === 3) continue;
          const [a, b] = tripWindow(i, c, rt);
          if (now < a - 1 || now > b + 20) continue;
          seen.add(key); out.push({ i, ctx: c, key, rt });
        }
      }
      return out;
    }
    return { servicesOn, contexts, delaysFor, tripWindow, stopTimes, activeTrips };
  }

  return { partsAt, tzOffset, madridEpoch, ymd, shiftDay, pad2, consistent, createModel, TZ };
});
