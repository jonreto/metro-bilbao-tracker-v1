'use strict';
// Minimal ZIP reader (stored + deflate), enough for GTFS archives. No dependencies.
const zlib = require('zlib');

function unzip(buf) {
  const u = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  // find End Of Central Directory record
  let eocd = -1;
  for (let i = u.length - 22; i >= Math.max(0, u.length - 65557); i--) {
    if (u.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end of central directory)');
  const count = u.readUInt16LE(eocd + 10);
  let p = u.readUInt32LE(eocd + 16);
  const files = {};
  for (let n = 0; n < count; n++) {
    if (u.readUInt32LE(p) !== 0x02014b50) throw new Error('Bad central directory entry');
    const method = u.readUInt16LE(p + 10);
    const csize = u.readUInt32LE(p + 20);
    const nameLen = u.readUInt16LE(p + 28), extraLen = u.readUInt16LE(p + 30), commentLen = u.readUInt16LE(p + 32);
    const local = u.readUInt32LE(p + 42);
    const name = u.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const lNameLen = u.readUInt16LE(local + 26), lExtraLen = u.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = u.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`Unsupported compression method ${method} for ${name}`);
    files[name.split('/').pop()] = data;
  }
  return files;
}
module.exports = { unzip };
