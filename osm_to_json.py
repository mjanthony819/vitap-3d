#!/usr/bin/env python3
"""Convert raw OSM XML (api.openstreetmap.org map call) into compact campus.json
for the VIT-AP 3D map. Coordinates become local meters (x east, y north) relative
to campus centre. No dependencies beyond the stdlib."""
import xml.etree.ElementTree as ET, json, math, sys

SRC = '/tmp/vitap_map.osm'
LAT0, LON0 = 16.4928035, 80.4982427   # OSM campus centre (way 750542244)
MLAT = 110574.0
MLON = 111320.0 * math.cos(math.radians(LAT0))

t = ET.parse(SRC); root = t.getroot()
nodes, ways = {}, {}
for n in root.findall('node'):
    nodes[n.get('id')] = (float(n.get('lat')), float(n.get('lon')),
                          {k.get('k'): k.get('v') for k in n.findall('tag')})
for w in root.findall('way'):
    ways[w.get('id')] = ([nd.get('ref') for nd in w.findall('nd')],
                         {k.get('k'): k.get('v') for k in w.findall('tag')})

def xy(lat, lon):
    return [round((lon - LON0) * MLON, 2), round((lat - LAT0) * MLAT, 2)]

def ring(refs):
    pts = [xy(*nodes[r][:2]) for r in refs if r in nodes]
    if len(pts) > 2 and pts[0] == pts[-1]: pts.pop()
    return pts

def centroid(pts):
    a = cx = cy = 0.0
    for i in range(len(pts)):
        x0, y0 = pts[i]; x1, y1 = pts[(i+1) % len(pts)]
        cross = x0*y1 - x1*y0; a += cross
        cx += (x0+x1)*cross; cy += (y0+y1)*cross
    if abs(a) < 1e-9:
        return [sum(p[0] for p in pts)/len(pts), sum(p[1] for p in pts)/len(pts)]
    a *= 0.5
    return [round(cx/(6*a),2), round(cy/(6*a),2)]

def inside_poly(px, py, poly):
    """Ray-casting point-in-polygon test in data-frame metres."""
    inside = False
    j = len(poly) - 1
    for i in range(len(poly)):
        xi, yi = poly[i]; xj, yj = poly[j]
        if (yi > py) != (yj > py) and px < (xj - xi) * (py - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside

BUILD_DEFAULT_LEVELS = {'university': 3, 'dormitory': 5, 'office': 3, 'house': 1, 'yes': 2}
CATEGORY = {'university': 'academic', 'dormitory': 'hostel', 'office': 'office',
            'house': 'house', 'yes': 'other'}
campus_poly = ring(ways['750542244'][0]) if '750542244' in ways else None
buildings = []
for wid, (refs, tg) in ways.items():
    if 'building' not in tg: continue
    pts = ring(refs)
    if len(pts) < 3: continue
    btype = tg.get('building', 'yes')
    levels_tag = tg.get('building:levels')
    levels = int(levels_tag) if levels_tag and levels_tag.isdigit() else None
    approx = levels is None
    if levels is None: levels = BUILD_DEFAULT_LEVELS.get(btype, 2)
    c = centroid(pts)
    if campus_poly and not inside_poly(c[0], c[1], campus_poly):
        continue  # off-campus building: drop (matches deployed campus.json)
    buildings.append({'id': wid, 'name': tg.get('name'), 'type': btype,
                      'cat': CATEGORY.get(btype, 'other'), 'levels': levels,
                      'approxHeight': approx, 'poly': pts, 'c': c})

WALK = {'footway','service','path','tertiary','secondary','unclassified','track','corridor','residential','pedestrian','steps','crossing'}
paths, graph_nodes, graph_edges = [], {}, []
for wid, (refs, tg) in ways.items():
    hw = tg.get('highway')
    if not hw or hw == 'construction': continue
    pts = [xy(*nodes[r][:2]) for r in refs if r in nodes]
    if len(pts) < 2: continue
    walk = hw in WALK and tg.get('access') not in ('private','no')
    paths.append({'id': wid, 'kind': hw, 'name': tg.get('name') or tg.get('ref'),
                  'walk': walk, 'pts': pts})
    if walk:
        seq = []
        for r in refs:
            if r not in nodes: continue
            if r not in graph_nodes: graph_nodes[r] = xy(*nodes[r][:2])
            seq.append(r)
        for a, b in zip(seq, seq[1:]):
            if a != b: graph_edges.append([a, b])

pois, sports, gardens, water, tree_rows, trees = [], [], [], [], [], []
for wid, (refs, tg) in ways.items():
    name = tg.get('name')
    if tg.get('leisure') == 'pitch':
        pts = ring(refs); sports.append({'name': name, 'kind': 'pitch', 'poly': pts, 'c': centroid(pts) if pts else None})
    elif tg.get('leisure') == 'garden':
        pts = ring(refs); gardens.append({'poly': pts})
    elif tg.get('natural') == 'water':
        pts = ring(refs); water.append({'poly': pts})
    elif tg.get('natural') == 'tree_row':
        pts = [xy(*nodes[r][:2]) for r in refs if r in nodes]
        if len(pts) >= 2: tree_rows.append(pts)
    elif tg.get('amenity') == 'fountain':
        pts = ring(refs); pois.append({'name': name or 'Fountain', 'kind': 'fountain', 'c': centroid(pts) if pts else None})
    elif tg.get('amenity') == 'theatre':
        pts = ring(refs); pois.append({'name': name or 'Open-air theatre', 'kind': 'theatre', 'c': centroid(pts) if pts else None})
    elif tg.get('amenity') == 'parking':
        pts = ring(refs); pois.append({'name': name or 'Parking', 'kind': 'parking', 'c': centroid(pts) if pts else None})

POI_NODE_KINDS = {'amenity','tourism','leisure','man_made','shop','office'}
for nid, (lat, lon, tg) in nodes.items():
    if tg.get('natural') == 'tree': trees.append(xy(lat, lon)); continue
    if not POI_NODE_KINDS.intersection(tg): continue
    kind = tg.get('amenity') or tg.get('tourism') or tg.get('leisure') or tg.get('man_made') or tg.get('shop') or tg.get('office')
    pois.append({'name': tg.get('name') or kind.replace('_',' ').title(), 'kind': kind, 'c': xy(lat, lon)})

# Hostels confirmed by the site owner's circled screenshots but not yet mapped in OSM.
# Approximate positions only - no footprints exist in OSM for these two blocks.
pois.append({'name': 'MH-4', 'kind': 'hostel (approx. location)', 'c': [301.5, -95.6]})
pois.append({'name': 'MH-5', 'kind': 'hostel (approx. location)', 'c': [325.71, 169.48]})

out = {'center': [LAT0, LON0], 'campusPoly': campus_poly, 'buildings': buildings,
       'paths': paths, 'graph': {'nodes': graph_nodes, 'edges': graph_edges},
       'sports': sports, 'gardens': gardens, 'water': water,
       'treeRows': tree_rows, 'trees': trees, 'pois': pois}
with open('campus.json', 'w') as f: json.dump(out, f, separators=(',', ':'))
named = [b['name'] for b in buildings if b['name']]
print('buildings', len(buildings), 'named:', named)
print('paths', len(paths), 'walk graph nodes', len(graph_nodes), 'edges', len(graph_edges))
print('sports', len(sports), 'pois', len(pois), 'treeRows', len(tree_rows), 'trees', len(trees), 'water', len(water), 'gardens', len(gardens))
print('campusPoly pts', len(campus_poly) if campus_poly else None)
import os; print('campus.json bytes', os.path.getsize('campus.json'))
