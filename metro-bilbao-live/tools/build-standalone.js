#!/usr/bin/env node
// Bundles the front end and its data into one self-contained HTML file (timetable only, no live feed, no tiles).
//   node tools/build-standalone.js            → dist/metro-bilbao-live.html   (open by double-clicking)
//   node tools/build-standalone.js --fragment → dist/metro-bilbao-live.fragment.html (body-only, for hosts that add their own <html>/<head>)
const fs = require('fs'), path = require('path');
const pub = f => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const fragment = process.argv.includes('--fragment');
const html = pub('index.html');
const body = html.slice(html.indexOf('<!--APP-->'), html.indexOf('<!--/APP-->') + 11);
const fonts = html.match(/<link href="https:\/\/fonts[^>]+>/)[0];
const safe = s => s.replace(/<\/script/gi, '<\\/script');
const data = `window.__MB_STANDALONE=true;window.__MB_TT=${pub('timetable.json')};window.__MB_BM=${pub('basemap.json')};`;
const inner = `<title>Metro Bilbao Live</title>
${fonts}
<style>${pub('style.css')}</style>
${body}
<script>${safe(data)}</script>
<script>${safe(pub('core.js'))}</script>
<script>${safe(pub('app.js'))}</script>`;
const out = fragment ? inner : `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${inner.replace('</style>', '</style>\n</head>\n<body>')}
</body>
</html>`;
const dir = path.join(__dirname, '..', 'dist'); fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, fragment ? 'metro-bilbao-live.fragment.html' : 'metro-bilbao-live.html');
fs.writeFileSync(file, out);
console.log(`Wrote ${file} (${Math.round(out.length / 1024)} KB)`);
