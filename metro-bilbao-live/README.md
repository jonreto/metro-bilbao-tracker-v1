# Metro Bilbao Live

A live map of Metro Bilbao lines L1 and L2. It shows where every train is right now, how late it's running and the next departures from each station. Live delays come from the Bizkaia Transport Consortium's (CTB) official GTFS-Realtime feed. The map covers Bizkaia only.

No dependencies: the server is plain Node (18 or newer) and the front end is vanilla JS and SVG.

## Run it

```bash
node server.js          # → http://localhost:8080
```

The server:

- serves the front end from `public/`;
- `GET /api/live` fetches CTB's trip-updates, vehicle-positions and service-alerts feeds (protobuf), decodes them and returns one small JSON document. It's cached for 12 s, uses conditional requests, and sends one upstream fetch at a time however many browsers are open;
- `GET /api/timetable` downloads Metro Bilbao's official GTFS, rebuilds the compact timetable and caches it for 6 h. If the download fails it falls back to the snapshot in `public/timetable.json`.

The page polls `/api/live` every 15 s. If there's no API (for example, if you only open `public/` with a static server), the map says **Timetable** and places trains from the timetable.

### Environment variables

| variable | default | |
|---|---|---|
| `PORT` | `8080` | |
| `GTFS_URL` | `https://cms.metrobilbao.eus/get/open_data/horarios/es` | official static GTFS |
| `CTB_RT_BASE` | `https://ctb-gtfs-rt.s3.eu-south-2.amazonaws.com/metro-bilbao-` | prefix for the three `.pb` feeds |
| `RT_TTL_MS` | `12000` | live cache |
| `GTFS_REFRESH_MS` | `21600000` | timetable rebuild interval |

## Deploy to Vercel

The repo is ready as it is: `api/live.js` and `api/timetable.js` are serverless functions, and `public/` is the static output. Run `vercel` from this folder (or import it into Vercel from GitHub). Nothing needs building. The timetable function is CDN-cached for 6 h, so the GTFS refreshes itself.

## Why a server is needed

CTB's S3 bucket sends no CORS headers, so a browser page can't read the feeds directly. I checked this on 27 September 2026: a cross-origin `fetch` fails. The feeds are also protobuf. `lib/gtfsrt.js` is a small dependency-free decoder for the parts of `gtfs-realtime.proto` that CTB publishes.

## How positions and delays work

1. **Timetable.** `lib/timetable.js` turns the GTFS into about 190 KB of JSON: 42 stations, 71 unique running patterns and 8,135 trips (with their GTFS `trip_id`s), plus station-to-station track geometry cut from `shapes.txt`.
2. **Service days.** After midnight, trains belong to the *previous* day's service (GTFS times such as `24:26:00`). Every query looks at today's and yesterday's service. Times count from "noon minus 12 h" in Europe/Madrid, which is correct on DST change days too (`public/core.js`).
3. **Live matching.** CTB's `trip_id`s match the static GTFS exactly. Each trip update gives a predicted arrival time at each remaining station, and often at the same unit's next trips too. For every prediction the delay is `predicted − scheduled`:
   - stops the train has already passed take the first prediction's delay;
   - gaps are interpolated and the last delay carries on to the terminus;
   - inconsistent predictions are dropped: the model keeps the longest run whose predicted times increase along the route. The live feed sometimes puts Gobela *after* Sopela with an 18-minute "delay", and without this filter that would teleport the train;
   - the service day with the smaller delay wins, so a `trip_id` that runs every Saturday night is matched to the right night.
4. **Movement.** Between stations a train follows the real track geometry. It accelerates out of one station and brakes into the next, with dwell times from the timetable plus delay. When a new prediction arrives, delays blend over 4 s so trains don't jump.
5. **Cancelled** trips (`schedule_relationship = CANCELED`) are hidden, and **skipped** stops are struck through.

Positions are estimates. No open feed has signalling-level train positions, and the vehicle-positions feed usually lists only one or two trains.

## L1 and L2

Metro Bilbao is a "Y". **L1** runs Etxebarri – Plentzia (right bank / Uribe Kosta). **L2** runs Basauri – Kabiezes (left bank / Ezkerraldea). They share the track between Etxebarri and San Ignazio.

The GTFS has a single route (`MB`) for both lines, so the line has to be inferred. The prototype marked any train calling at Basauri or Ariz as L2. That was wrong: some L1 trains start at Basauri (Basauri → Plentzia / Sopela / Ibarbengoa, about 100 trips in the current feed). Now:

- a trip that serves any station from Lutxana to Plentzia is **L1**;
- a trip that serves any station from Gurutzeta to Kabiezes is **L2**;
- trunk-only short workings are L2 if they run to or from Basauri or Ariz, and L1 otherwise.

Track colours follow the official lines rather than the trains that use them: the trunk is drawn as two parallel lines, and Basauri–Ariz–Etxebarri is L2 only. If a station is ever added or renamed, the build warns about names it doesn't recognise (`lib/timetable.js`).

## The map

`public/basemap.json` (141 KB) is a vector map of Bizkaia. Panning and zooming stop at the province boundary:

- land, coast and municipal boundaries: Basque Government municipal boundaries (Eustat/GeoEuskadi);
- the Ría del Nervión, estuaries, main rivers, motorways and trunk roads: © OpenStreetMap contributors, ODbL;
- neighbouring areas: OpenStreetMap land polygons.

When served, the page can also show **Esri Light/Dark Gray Canvas** tiles (the map button), clipped to the Bizkaia outline. Keyless `server.arcgisonline.com` tiles are fine for personal use. A public deployment should use an ArcGIS Location Platform key (set `window.MB_CONFIG = { tileUrl: {...} }` before `app.js`), or set `tiles: false`.

`tools/build-basemap.py` is the script that produced it. It needs the source files listed at its top.

## Files

```
server.js               local server (static + /api/live + /api/timetable)
api/                    the same two endpoints as Vercel functions
lib/gtfsrt.js           GTFS-Realtime protobuf decoder
lib/realtime.js         polls CTB, returns compact live JSON
lib/timetable.js        GTFS → compact timetable (line classification lives here)
lib/static-feed.js      downloads/rebuilds/caches the timetable
lib/zip.js              minimal unzip for the GTFS archive
public/index.html       page shell
public/style.css        styles (light and dark)
public/core.js          service-day + delay model (shared with tests)
public/app.js           map, trains, panels
public/timetable.json   bundled timetable snapshot (valid 26 Sep – 26 Oct 2026)
public/basemap.json     Bizkaia vector basemap
tools/build-timetable.js    rebuild the snapshot: node tools/build-timetable.js [gtfs.zip|folder]
tools/build-standalone.js   single-file offline build → dist/
tools/build-basemap.py      how basemap.json was made
test/                   node:test suites + GTFS-RT fixtures from a real feed snapshot
dist/metro-bilbao-live.html  self-contained, timetable-only version (double-click to open)
```

## Testing

```bash
npm test
```

The tests cover the protobuf decoder (including negative delays), unzip, CSV, L1/L2 classification of every pattern in the feed, and track colours. They also cover the after-midnight service days, calendar exceptions (the 12 October holiday), DST, per-stop delays against a real CTB snapshot, the Gobela outlier, late trains staying on the map past their scheduled arrival, and cancellations.

To look at any moment in the browser, add `?at=2026-09-27T00:26` (Madrid time) to the URL. `&speed=20` fast-forwards.

## Not done yet

- Line 3 (Euskotren) isn't included. Its feeds are on data.ctb.eus in the same format, so `lib/realtime.js` could take a second prefix.
- Train length (4 or 5 cars) isn't in the open feeds. Metro Bilbao's unofficial `trenes.php` has it.
- Punctuality history: `/api/live` could be logged to build it.
