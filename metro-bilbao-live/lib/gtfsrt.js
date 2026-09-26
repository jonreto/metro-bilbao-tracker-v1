// Minimal, dependency-free GTFS-Realtime protobuf decoder.
// Covers the parts of gtfs-realtime.proto that Metro Bilbao / CTB publish.
'use strict';
const S = {
  FeedMessage: { 1: ['header', 'FeedHeader'], 2: ['entity', 'FeedEntity', true] },
  FeedHeader: { 1: ['gtfs_realtime_version', 'string'], 2: ['incrementality', 'enum'], 3: ['timestamp', 'uint'] },
  FeedEntity: { 1: ['id', 'string'], 2: ['is_deleted', 'bool'], 3: ['trip_update', 'TripUpdate'], 4: ['vehicle', 'VehiclePosition'], 5: ['alert', 'Alert'] },
  TripUpdate: { 1: ['trip', 'TripDescriptor'], 2: ['stop_time_update', 'StopTimeUpdate', true], 3: ['vehicle', 'VehicleDescriptor'], 4: ['timestamp', 'uint'], 5: ['delay', 'int'] },
  StopTimeUpdate: { 1: ['stop_sequence', 'uint'], 2: ['arrival', 'StopTimeEvent'], 3: ['departure', 'StopTimeEvent'], 4: ['stop_id', 'string'], 5: ['schedule_relationship', 'enum'] },
  StopTimeEvent: { 1: ['delay', 'int'], 2: ['time', 'int'], 3: ['uncertainty', 'int'] },
  TripDescriptor: { 1: ['trip_id', 'string'], 2: ['start_time', 'string'], 3: ['start_date', 'string'], 4: ['schedule_relationship', 'enum'], 5: ['route_id', 'string'], 6: ['direction_id', 'uint'] },
  VehicleDescriptor: { 1: ['id', 'string'], 2: ['label', 'string'], 3: ['license_plate', 'string'] },
  VehiclePosition: { 1: ['trip', 'TripDescriptor'], 2: ['position', 'Position'], 3: ['current_stop_sequence', 'uint'], 4: ['current_status', 'enum'], 5: ['timestamp', 'uint'], 6: ['congestion_level', 'enum'], 7: ['stop_id', 'string'], 8: ['vehicle', 'VehicleDescriptor'], 9: ['occupancy_status', 'enum'] },
  Position: { 1: ['latitude', 'float'], 2: ['longitude', 'float'], 3: ['bearing', 'float'], 4: ['odometer', 'double'], 5: ['speed', 'float'] },
  Alert: { 1: ['active_period', 'TimeRange', true], 5: ['informed_entity', 'EntitySelector', true], 6: ['cause', 'enum'], 7: ['effect', 'enum'], 8: ['url', 'TranslatedString'], 10: ['header_text', 'TranslatedString'], 11: ['description_text', 'TranslatedString'] },
  TimeRange: { 1: ['start', 'uint'], 2: ['end', 'uint'] },
  EntitySelector: { 1: ['agency_id', 'string'], 2: ['route_id', 'string'], 3: ['route_type', 'int'], 4: ['trip', 'TripDescriptor'], 5: ['stop_id', 'string'], 6: ['direction_id', 'uint'] },
  TranslatedString: { 1: ['translation', 'Translation', true] },
  Translation: { 1: ['text', 'string'], 2: ['language', 'string'] },
};
const td = new TextDecoder();
function decode(buf, type = 'FeedMessage') {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  function varint(st, signed) {
    const s0 = st.p; let r = 0, m = 1, b;
    do { b = u8[st.p++]; r += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
    if (st.p - s0 < 8) return r; // < 2^49: exact as a Number
    let big = 0n, sh = 0n;
    for (let i = s0; i < st.p; i++, sh += 7n) big |= BigInt(u8[i] & 0x7f) << sh;
    if (signed) big = BigInt.asIntN(64, big);
    return Number(big);
  }
  function msg(start, end, t) {
    const sch = S[t], o = {}, st = { p: start };
    while (st.p < end) {
      const key = varint(st), f = Math.floor(key / 8), wt = key & 7;
      const d = sch && sch[f];
      let v;
      if (wt === 0) {
        v = varint(st, d && d[1] === 'int');
        if (d && d[1] === 'bool') v = !!v;
      } else if (wt === 1) { v = dv.getFloat64(st.p, true); st.p += 8; }
      else if (wt === 5) { v = dv.getFloat32(st.p, true); st.p += 4; }
      else if (wt === 2) {
        const len = varint(st), s = st.p; st.p += len;
        if (!d) continue;
        v = d[1] === 'string' ? td.decode(u8.subarray(s, s + len)) : msg(s, s + len, d[1]);
      } else throw new Error('unsupported wire type ' + wt);
      if (!d) continue;
      if (d[2]) (o[d[0]] = o[d[0]] || []).push(v); else o[d[0]] = v;
    }
    return o;
  }
  return msg(0, u8.length, type);
}
if (typeof module !== 'undefined') module.exports = { decode };
