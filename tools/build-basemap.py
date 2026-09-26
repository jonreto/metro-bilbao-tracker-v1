"""
How public/basemap.json was built (for reference; you don't need to run it).

Inputs, in the working directory:
  muni-euskadi.geojson  Basque Government municipal boundaries (Eustat/GeoEuskadi), all of the Basque Country.
                        Copy used: github.com/montera34/airbnbeuskadi/blob/master/data/municipios-euskadi.geojson
  land_bbox.json        OpenStreetMap land polygon clipped to lon -3.50..-2.38, lat 42.95..43.50
                        (from github.com/simonepri/geo-maps earth-lands-10m), used only outside the Basque Country
  osm_layers.json       from Overpass (OpenStreetMap, ODbL), in 4 m units (same projection, y down):
                          coastwater  sea + Ría del Nervión polygon built from natural=coastline
                                      in 43.235..43.36 N, -3.08..-2.90 E (OSM coastline runs up the Ría to Bilbao)
                          bigwater    large natural=water areas in Bizkaia (Urdaibai estuary, Nervión, reservoirs)
                          rivers      waterway=river lines of the main rivers
                          motorways   highway=motorway, trunks  highway=trunk

Projection: Web Mercator metres relative to (-2.95, 43.28), y pointing down, matching lib/timetable.js.
Output coordinates are stored in 4 m units, delta-encoded.

Requires: pip install shapely numpy
"""
import json, math, shapely
from shapely.geometry import shape, box, mapping, Polygon, LineString
from shapely.ops import transform, linemerge, polylabel
from shapely.affinity import scale as _sc

R = 6378137.0
LON0, LAT0 = -2.95, 43.28
X0 = R * math.radians(LON0)
Y0 = R * math.log(math.tan(math.pi / 4 + math.radians(LAT0) / 2))

def proj(x, y, z=None):
    import numpy as np
    x = np.asarray(x); y = np.asarray(y)
    return (R * np.radians(x) - X0, -(R * np.log(np.tan(np.pi / 4 + np.radians(y) / 2)) - Y0))
P = lambda g: transform(proj, g)

m = json.load(open('muni-euskadi.geojson'))
munis = []; eus = []
for f in m['features']:
    g = P(shape(f['geometry']).buffer(0))
    eus.append(g)
    if f['properties']['he_kod'] == '48':        # 48 = Bizkaia
        pr = f['properties']
        munis.append((pr['iz_ofizial'] or pr['ud_iz_e'] or '', pr['ud_kodea'], g))
biz = shapely.union_all([g for _, _, g in munis]).buffer(0)
eusU = shapely.union_all(eus).buffer(0)
land10 = P(shape(json.load(open('land_bbox.json'))))

# extent: Bizkaia bounds + 6 km
bx0, by0, bx1, by1 = biz.bounds
M = 6000
BB = box(bx0 - M, by0 - M, bx1 + M, by1 + M)
other = land10.difference(eusU)
other = other.buffer(-250).buffer(250)          # remove slivers where the coarse coast overhangs the detailed one
other = shapely.union_all([p for p in getattr(other, 'geoms', [other]) if p.area > 2e6])
# port platforms and breakwaters missing from the municipal polygons
extra = [p for p in getattr(other, 'geoms', [other]) if p.area < 30e6 and p.distance(biz) < 300]
if extra:
    biz = shapely.union_all([biz] + [e.buffer(20) for e in extra]).buffer(0)
    other = other.difference(shapely.union_all(extra).buffer(25))
landall = shapely.union_all([eusU, other.buffer(40), biz]).intersection(BB)
seaall = BB.difference(landall)
north = box(BB.bounds[0], BB.bounds[1], BB.bounds[2], BB.bounds[1] + 10)
sea = shapely.union_all([p for p in getattr(seaall, 'geoms', [seaall]) if p.intersects(north)])
landall = BB.difference(sea)

O = json.load(open('osm_layers.json'))
up = lambda g: _sc(shape(g), xfact=4, yfact=4, origin=(0, 0))
water = shapely.union_all([up(O['coastwater']), up(O['bigwater'])]).buffer(0).intersection(biz.buffer(50))
water = shapely.union_all([p for p in getattr(water, 'geoms', [water]) if p.area > 2e4])
def upl(ls): return [LineString([(x * 4, y * 4) for x, y in l]) for l in ls if len(l) > 1]
rivers = shapely.union_all(upl(O['rivers'])).intersection(BB).difference(water)
motorways = shapely.union_all(upl(O['motorways'])).intersection(BB)
trunks = shapely.union_all(upl(O['trunks'])).intersection(BB)

lines = shapely.union_all([g.boundary for _, _, g in munis]).difference(biz.boundary.buffer(30))
lines = linemerge(lines) if lines.geom_type == 'MultiLineString' else lines

Q = 4
def simp(g, t): return g.simplify(t, preserve_topology=True)
def ring(coords):
    pts = [(round(x / Q), round(y / Q)) for x, y in coords]
    out = [pts[0][0], pts[0][1]]; px, py = pts[0]
    for x, y in pts[1:]:
        if (x, y) == (px, py): continue
        out += [x - px, y - py]; px, py = x, y
    return out
def polys(g, t):
    g = simp(g, t); res = []
    for p in getattr(g, 'geoms', [g]):
        if p.is_empty or p.geom_type != 'Polygon': continue
        res.append([ring(p.exterior.coords)] + [ring(i.coords) for i in p.interiors if Polygon(i).area > 2e4])
    return res
def lns(g, t):
    g = simp(g, t); res = []
    for l in getattr(g, 'geoms', [g]):
        if l.length > 60: res.append(ring(l.coords))
    return res

labels = []
for name, code, g in munis:
    if not name or 'partzuergoa' in name.lower(): continue       # shared-pasture areas, not towns
    big = max(getattr(g, 'geoms', [g]), key=lambda p: p.area)
    pt = polylabel(big, 20)
    labels.append([name.split('/')[0].strip(), round(pt.x / Q), round(pt.y / Q), round(g.area / 1e6, 1)])
labels.sort(key=lambda l: -l[3])

out = {'q': Q, 'origin': [LON0, LAT0], 'bounds': [round(v / Q) for v in BB.bounds],
       'biz': polys(biz, 8), 'land': polys(landall, 15), 'sea': polys(sea, 12), 'water': polys(water, 6),
       'munilines': lns(lines, 10), 'labels': labels,
       'rivers': lns(rivers, 12), 'motorways': lns(motorways, 15), 'trunks': lns(trunks, 15)}
s = json.dumps(out, separators=(',', ':'), ensure_ascii=False)
open('basemap.json', 'w').write(s)
print('basemap.json', len(s) // 1024, 'KB')
