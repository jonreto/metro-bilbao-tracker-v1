'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { decode } = require('../lib/gtfsrt');
const { encode } = require('./pb-encode');
const { unzip } = require('../lib/zip');
const { lineOf, parseCSV } = require('../lib/timetable');
const TT = require('../public/timetable.json');
const fx = f => fs.readFileSync(path.join(__dirname, 'fixtures', f));

test('decodes the real CTB trip-updates snapshot', () => {
  const m = decode(fx('metro-bilbao-trip-updates.pb'));
  assert.equal(m.header.gtfs_realtime_version, '2.0');
  assert.equal(m.header.timestamp, 1790462562);
  assert.equal(m.entity.length, 9);
  const t = m.entity.find(e => e.trip_update.trip.trip_id === '878384').trip_update;
  assert.equal(t.vehicle.id, '508');
  assert.deepEqual(t.stop_time_update[0], { stop_id: '32.0', arrival: { time: 1790462530 } });
});

test('decodes negative delays (10-byte varints) exactly', () => {
  const buf = encode({ delay: -60, time: 1790462530 }, 'StopTimeEvent');
  assert.deepEqual(decode(buf, 'StopTimeEvent'), { delay: -60, time: 1790462530 });
  assert.equal(decode(encode({ delay: -7 }, 'StopTimeEvent'), 'StopTimeEvent').delay, -7);
});

test('decodes alerts with translations and floats in vehicle positions', () => {
  const a = decode(fx('metro-bilbao-service-alerts.pb')).entity[0].alert;
  assert.equal(a.header_text.translation.find(t => t.language === 'en').text, 'Lift out of service at Abando');
  assert.equal(a.informed_entity[0].stop_id, '7.0');
  const v = decode(fx('metro-bilbao-vehicle-positions.pb')).entity[0].vehicle;
  assert.ok(Math.abs(v.position.latitude - 43.33308) < 1e-4);
});

test('unzips stored and deflated entries', () => {
  // build a two-file zip by hand: one stored, one deflated
  const files = [['a.txt', Buffer.from('hello,world\n'), 0], ['stops.txt', Buffer.from('x'.repeat(500)), 8]];
  const local = [], central = []; let off = 0;
  for (const [name, data, method] of files) {
    const comp = method ? zlib.deflateRawSync(data) : data; const nb = Buffer.from(name);
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(method, 8); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nb.length, 26);
    local.push(h, nb, comp);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(method, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nb.length, 28); c.writeUInt32LE(off, 42);
    central.push(c, nb); off += 30 + nb.length + comp.length;
  }
  const cd = Buffer.concat(central); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(2, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  const out = unzip(Buffer.concat([...local, cd, e]));
  assert.equal(out['a.txt'].toString(), 'hello,world\n');
  assert.equal(out['stops.txt'].length, 500);
});

test('CSV parser handles BOM, quotes and CRLF', () => {
  const rows = parseCSV('﻿route_id,route_short_name,route_long_name\r\nMB,"","Línea ""De"" Metro"\r\nX,"a,b",c\r\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].route_long_name, 'Línea "De" Metro');
  assert.equal(rows[1].route_short_name, 'a,b');
});

test('L1/L2 are decided by branch, not by Basauri', () => {
  assert.equal(lineOf(['Basauri', 'Ariz', 'Etxebarri', 'San Ignazio', 'Lutxana', 'Plentzia']), 1);   // L1 train starting at Basauri
  assert.equal(lineOf(['Etxebarri', 'Bolueta', 'San Ignazio', 'Gurutzeta/Cruces', 'Kabiezes']), 2);  // L2 short of Basauri
  assert.equal(lineOf(['Santurtzi', 'Portugalete', 'San Ignazio', 'Etxebarri']), 2);                 // L2 short working
  assert.equal(lineOf(['Basauri', 'Ariz', 'Etxebarri', 'San Ignazio']), 2);                          // trunk-only from Basauri
  assert.equal(lineOf(['San Ignazio', 'Sarriko', 'Etxebarri']), 1);                                   // trunk-only otherwise
  assert.equal(lineOf(['Astrabudua', 'Lutxana', 'San Ignazio', 'Basauri']), 1);
});

test('bundled timetable: every pattern classified correctly, track colours follow the official lines', () => {
  const name = i => TT.st[i][0];
  const L1 = /Lutxana|Erandio|Astrabudua|Leioa|Lamiako|Areeta|Gobela|Neguri|Aiboa|Algorta|Bidezabal|Ibarbengoa|Berango|Larrabasterra|Sopela|Urduliz|Plentzia/;
  const L2 = /Gurutzeta|Ansio|Barakaldo|Bagatza|Urbinaga|Sestao|Abatxolo|Portugalete|Peñota|Santurtzi|Kabiezes/;
  for (const [seq, , line] of TT.prof) {
    const names = seq.map(name).join(' ');
    if (L1.test(names)) assert.equal(line, 1, names);
    if (L2.test(names)) assert.equal(line, 2, names);
  }
  const seg = (a, b) => { const ia = TT.st.findIndex(s => s[0].startsWith(a)), ib = TT.st.findIndex(s => s[0].startsWith(b)); return TT.segLine[`${ia}-${ib}`] ?? TT.segLine[`${ib}-${ia}`]; };
  assert.equal(seg('Basauri', 'Ariz'), 2);
  assert.equal(seg('Ariz', 'Etxebarri'), 2);
  assert.equal(seg('Etxebarri', 'Bolueta'), 3);
  assert.equal(seg('Sarriko', 'San Ignazio'), 3);
  assert.equal(seg('San Ignazio', 'Lutxana'), 1);
  assert.equal(seg('San Ignazio', 'Gurutzeta'), 2);
  assert.equal(TT.st.length, 42);
  assert.equal(TT.stopMap['42.0'], TT.st.findIndex(s => s[0] === 'Kabiezes'));
});
