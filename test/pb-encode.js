'use strict';
// Tiny protobuf encoder for building GTFS-RT test fixtures (mirror of lib/gtfsrt.js's schema).
const F = {
  FeedMessage: { header: [1, 'FeedHeader'], entity: [2, 'FeedEntity', true] },
  FeedHeader: { gtfs_realtime_version: [1, 'string'], incrementality: [2, 'varint'], timestamp: [3, 'varint'] },
  FeedEntity: { id: [1, 'string'], trip_update: [3, 'TripUpdate'], vehicle: [4, 'VehiclePosition'], alert: [5, 'Alert'] },
  TripUpdate: { trip: [1, 'TripDescriptor'], stop_time_update: [2, 'StopTimeUpdate', true], vehicle: [3, 'VehicleDescriptor'], timestamp: [4, 'varint'], delay: [5, 'varint'] },
  StopTimeUpdate: { stop_sequence: [1, 'varint'], arrival: [2, 'StopTimeEvent'], departure: [3, 'StopTimeEvent'], stop_id: [4, 'string'], schedule_relationship: [5, 'varint'] },
  StopTimeEvent: { delay: [1, 'varint'], time: [2, 'varint'] },
  TripDescriptor: { trip_id: [1, 'string'], schedule_relationship: [4, 'varint'], route_id: [5, 'string'], direction_id: [6, 'varint'] },
  VehicleDescriptor: { id: [1, 'string'], label: [2, 'string'] },
  VehiclePosition: { trip: [1, 'TripDescriptor'], position: [2, 'Position'], stop_id: [7, 'string'], timestamp: [5, 'varint'], vehicle: [8, 'VehicleDescriptor'] },
  Position: { latitude: [1, 'float'], longitude: [2, 'float'] },
  Alert: { active_period: [1, 'TimeRange', true], informed_entity: [5, 'EntitySelector', true], cause: [6, 'varint'], effect: [7, 'varint'], header_text: [10, 'TranslatedString'], description_text: [11, 'TranslatedString'] },
  TimeRange: { start: [1, 'varint'], end: [2, 'varint'] },
  EntitySelector: { route_id: [2, 'string'], stop_id: [5, 'string'] },
  TranslatedString: { translation: [1, 'Translation', true] },
  Translation: { text: [1, 'string'], language: [2, 'string'] },
};
function varint(n) {
  let b = BigInt.asUintN(64, BigInt(n)); const out = [];
  do { let x = Number(b & 0x7fn); b >>= 7n; if (b) x |= 0x80; out.push(x); } while (b);
  return out;
}
function encode(obj, type = 'FeedMessage') {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const d = F[type][k]; if (!d || v == null) continue;
    for (const item of d[2] ? v : [v]) {
      const [no, t] = d;
      if (t === 'varint') out.push(...varint(no << 3), ...varint(item));
      else if (t === 'float') { const b = Buffer.alloc(4); b.writeFloatLE(item); out.push(...varint((no << 3) | 5), ...b); }
      else { const body = t === 'string' ? [...Buffer.from(String(item))] : encode(item, t); out.push(...varint((no << 3) | 2), ...varint(body.length), ...body); }
    }
  }
  return out;
}
module.exports = { encode: (o, t) => Buffer.from(encode(o, t)) };
