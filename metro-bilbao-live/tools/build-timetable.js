#!/usr/bin/env node
// Rebuilds public/timetable.json (the bundled fallback snapshot).
//   node tools/build-timetable.js                 download the official GTFS
//   node tools/build-timetable.js path/to/gtfs.zip
//   node tools/build-timetable.js path/to/gtfs/   (unzipped folder)
const fs = require('fs'), path = require('path');
const { unzip } = require('../lib/zip');
const { buildTimetable } = require('../lib/timetable');
const { GTFS_URL } = require('../lib/static-feed');
(async () => {
  const src = process.argv[2];
  let files;
  if (!src) {
    console.log('Downloading', GTFS_URL);
    const r = await fetch(GTFS_URL); if (!r.ok) throw new Error('HTTP ' + r.status);
    files = unzip(Buffer.from(await r.arrayBuffer()));
  } else if (fs.statSync(src).isDirectory()) {
    files = Object.fromEntries(fs.readdirSync(src).filter(f => f.endsWith('.txt')).map(f => [f, fs.readFileSync(path.join(src, f))]));
  } else files = unzip(fs.readFileSync(src));
  const tt = buildTimetable(files);
  const out = path.join(__dirname, '..', 'public', 'timetable.json');
  fs.writeFileSync(out, JSON.stringify(tt));
  console.log(`Wrote ${out}: ${tt.st.length} stations, ${tt.trips.length} trips, valid ${tt.valid.join('–')}`);
})().catch(e => { console.error(e.message); process.exit(1); });
