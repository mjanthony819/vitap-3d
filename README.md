# VIT-AP 3D (unofficial campus map)

An **unofficial**, student-built interactive 3D map of the VIT-AP University campus in
Amaravati, Andhra Pradesh. Runs fully in the browser as a static site - no backend, no
accounts, no tracking. Not affiliated with or endorsed by VIT-AP University.

Inspired by campus-scale "city in 3D" projects such as the IIIT Kottayam 3D campus map
and Mumbai 3D.

## What it does

- **3D campus** - every building footprint from OpenStreetMap extruded to a block model
- **Search** - find any named building, court or place and fly the camera to it
- **Walking routes** - A* over the mapped footpaths, with distance and walk time (5 km/h)
- **Fresher tour** - an 11-stop guided fly-around with short grounded captions
- **Live day/night** - the sun follows real IST time (computed in the browser); windows
  and path lamps light up after dark, stars come out, or scrub time with the slider
- **Labels** - floating name tags, toggleable

## Honest limitations

- Heights are **approximate** (floor count x 3.2 m) except where mappers recorded floors
  (CB: 11, AB-1/AB-2: 3). These are block models, not architectural models.
- Only places named in OpenStreetMap are searchable; some campus buildings are not yet
  mapped (e.g. some hostel blocks appear unnamed). MH-4 and MH-5 have no OSM footprints,
  so they are shown as labels at approximate, user-confirmed spots only - no 3D blocks.
- Routes follow **mapped paths only**; real shortcuts, gates and closures are not known.
- Campus is under active construction - the map reflects what mappers have recorded.

## Data

All geometry comes from OpenStreetMap (copyright OpenStreetMap contributors, ODbL):
one `api.openstreetmap.org/api/0.6/map?bbox=...` call over the campus, converted by
`osm_to_json.py` (Python 3 stdlib only) into `campus.json`:

- 30 on-campus building footprints kept from 54 in the raw extract (the converter drops
  buildings whose centre falls outside the campus boundary), 10 named in OSM
- 129 road/path ways; walk graph: 683 nodes / 742 edges for routing
- tree rows, water bodies, gardens, fountains and other POIs, plus approximate MH-4/MH-5
  hostel markers added by the converter until OSM maps those blocks

## Stack

Plain ES modules + [three.js](https://threejs.org) r160 (vendored, no CDN, no build
step). Solar position from the standard SunCalc equations. Everything else is hand-rolled:
polygon extrusion, procedural window textures, ribbon geometry for roads, A* routing,
canvas-sprite labels.

## Run locally

Any static file server works:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Rebuild the data

```bash
curl 'https://api.openstreetmap.org/api/0.6/map?bbox=80.4925,16.4895,80.5035,16.4985' -o vitap_map.osm
# point SRC in osm_to_json.py at the file, then:
python3 osm_to_json.py
```
