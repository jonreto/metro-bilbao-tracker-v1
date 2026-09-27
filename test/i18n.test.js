'use strict';
// Every language file must have exactly the keys of the English one, with the same {placeholders}.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
global.window = {};
for (const l of ['en', 'es', 'eu']) require(path.join(__dirname, '..', 'public', 'i18n', l + '.js'));
const I = global.window.MB_I18N;
const ph = s => (s.match(/\{\w+\}/g) || []).sort().join(',');
for (const l of ['es', 'eu']) {
  test(`${l}.js has the same keys and placeholders as en.js`, () => {
    assert.deepEqual(Object.keys(I[l]).sort(), Object.keys(I.en).sort());
    for (const k of Object.keys(I.en)) assert.equal(ph(I[l][k]), ph(I.en[k]), `${l}: ${k}`);
  });
}
test('every t() key used in app.js exists in en.js', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const keys = new Set([...src.matchAll(/\bt\('([\w.]+)'/g)].map(m => m[1]));
  for (const m of src.matchAll(/\btn\('([\w.]+)'/g)) { keys.add(m[1] + '.one'); keys.add(m[1] + '.other'); }
  for (const m of html.matchAll(/data-i18n="([\w.]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) m[1].split(';').forEach(p => keys.add(p.split(':')[1]));
  // keys built at runtime ('effect.' + code, 'status.' + state…) end with a dot and are checked below
  const missing = [...keys].filter(k => k !== 'key' && !k.endsWith('.') && !(k in I.en));
  for (const k of ['status.', 'about.state.']) for (const s of ['live', 'stale', 'offline', 'error', 'loading']) assert.ok((k + s) in I.en, k + s);
  for (const s of ['500', '550', '600']) assert.ok(('train.series.' + s) in I.en);
  assert.deepEqual(missing, []);
});
