// VIT-AP 3D - unofficial interactive campus map.
// Data: OpenStreetMap (campus.json, pre-built from the raw OSM map API by osm_to_json.py).
// All coordinates are local meters relative to campus centre: x = east, y = north (world z = y).
import * as THREE from 'three';
import { OrbitControls } from './OrbitControls.js';

const FLOOR_H = 3.2;                 // metres per floor for extrusion
const WALK_SPEED_MPM = 5000 / 60;    // 5 km/h in metres per minute
const params = new URLSearchParams(location.search);

const CAT_COLORS = {
  academic: 0x8f9db3, hostel: 0xc08a5e, office: 0x7fa3c2,
  food: 0xd1b464, house: 0x9a9a8a, other: 0xa8a8b0,
};
const CAT_LABEL = {
  academic: 'Academic', hostel: 'Hostel', office: 'Office',
  food: 'Food', house: 'House', other: 'Building',
};
const ROAD_STYLE = {
  footway:     { w: 2.5, color: 0x9b8f7a },
  corridor:    { w: 2.0, color: 0x9b8f7a },
  path:        { w: 2.5, color: 0x9b8f7a },
  service:     { w: 4.5, color: 0x62666c },
  track:       { w: 3.5, color: 0x7d7057 },
  tertiary:    { w: 7.0, color: 0x54585e },
  secondary:   { w: 8.0, color: 0x54585e },
  unclassified:{ w: 6.0, color: 0x585c62 },
  residential: { w: 6.0, color: 0x585c62 },
  crossing:    { w: 2.5, color: 0x9b8f7a },
  steps:       { w: 2.5, color: 0x9b8f7a },
  pedestrian:  { w: 4.0, color: 0x9b8f7a },
};
const ALT_NAMES = {
  'CB':   'Central Block',
  'AB-1': 'Academic Block 1 (Sarvepalli Radhakrishnan Block)',
  'AB-2': 'Academic Block 2 (APJ Abdul Kalam Block)',
};

let DATA, scene, camera, renderer, controls;
let sunLight, hemiLight, lampPoints, lampGlow, stars;
let wallMats = [], routeMesh = null, ringMesh = null;
let labels = [], tweens = [], places = [], adj = new Map();
let state = { hour: 12, live: true, labels: true, tour: -1, selected: null };
let clock = new THREE.Clock();

init();

async function init() {
  DATA = await (await fetch('campus.json')).json();
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.5, 4000);
  camera.position.set(60, 300, 560);
  renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('scene'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 25;
  controls.maxDistance = 1400;
  controls.target.set(0, 10, 0);

  hemiLight = new THREE.HemisphereLight(0xbfd8ff, 0x3d4a3a, 0.9);
  sunLight = new THREE.DirectionalLight(0xffffff, 1.1);
  scene.add(hemiLight, sunLight, sunLight.target);

  buildGround(); buildRoads(); buildWaterGardens(); buildSports();
  buildBuildings(); buildTrees(); buildLamps(); buildStars();
  buildGraph(); buildPlaces(); buildRing();
  wireUI();

  if (params.get('t') !== null) { state.live = false; state.hour = parseFloat(params.get('t')); }
  else if (state.live) state.hour = istHours(new Date());
  updateSky();

  addEventListener('resize', onResize);
  const loadEl = document.getElementById('loading');
  if (params.get('fast')) loadEl.style.display = 'none'; else loadEl.classList.add('done');
  renderer.setAnimationLoop(tick);
  applyDebugParams();
}

/* ---------- geometry builders ---------- */

function shapeFromPoly(poly) {
  const s = new THREE.Shape();
  poly.forEach(([px, py], i) => (i ? s.lineTo(px, -py) : s.moveTo(px, -py)));
  return s;
}

function buildGround() {
  const g = new THREE.Mesh(
    new THREE.PlaneGeometry(2600, 2600),
    new THREE.MeshLambertMaterial({ color: 0x40603f })
  );
  g.rotation.x = -Math.PI / 2; g.position.y = -0.08; scene.add(g);
  if (DATA.campusPoly) {
    const geo = new THREE.ShapeGeometry(shapeFromPoly(DATA.campusPoly));
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x4e7347 }));
    m.position.y = 0.02; scene.add(m);
  }
}

function ribbon(pts, width, y) {
  // flat triangle-strip ribbon following a polyline, in world XZ
  const pos = [], idx = [];
  const hw = width / 2;
  for (let i = 0; i < pts.length; i++) {
    const [x0, z0] = pts[i];
    const [xA, zA] = pts[Math.max(0, i - 1)];
    const [xB, zB] = pts[Math.min(pts.length - 1, i + 1)];
    let dx = xB - xA, dz = zB - zA;
    const len = Math.hypot(dx, dz) || 1; dx /= len; dz /= len;
    pos.push(x0 - dz * hw, y, z0 + dx * hw, x0 + dz * hw, y, z0 - dx * hw);
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

function buildRoads() {
  const byKind = {};
  for (const p of DATA.paths) (byKind[p.kind] = byKind[p.kind] || []).push(p);
  for (const [kind, list] of Object.entries(byKind)) {
    const st = ROAD_STYLE[kind] || { w: 3, color: 0x707478 };
    const geos = list.map(p => ribbon(p.pts.map(([x, y]) => [x, -y]), st.w, kind === 'footway' || kind === 'corridor' || kind === 'path' ? 0.06 : 0.04));
    const merged = mergeGeoms(geos);
    scene.add(new THREE.Mesh(merged, new THREE.MeshLambertMaterial({ color: st.color, side: THREE.DoubleSide })));
  }
}

function mergeGeoms(geos) {
  // minimal non-indexed merge (positions + normals)
  let total = 0;
  const parts = geos.map(g => g.toNonIndexed());
  for (const g of parts) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3);
  let o = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    o += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  return out;
}

function buildWaterGardens() {
  for (const w of DATA.water) {
    if (w.poly.length < 3) continue;
    const geo = new THREE.ShapeGeometry(shapeFromPoly(w.poly)); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x2e5d8a }));
    m.position.y = 0.05; scene.add(m);
  }
  for (const gd of DATA.gardens) {
    if (gd.poly.length < 3) continue;
    const geo = new THREE.ShapeGeometry(shapeFromPoly(gd.poly)); geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: 0x527a42 }));
    m.position.y = 0.03; scene.add(m);
  }
}

function buildSports() {
  for (const s of DATA.sports) {
    if (!s.poly || s.poly.length < 3) continue;
    const geo = new THREE.ShapeGeometry(shapeFromPoly(s.poly)); geo.rotateX(-Math.PI / 2);
    const isCourt = /basket|tennis|volley|badminton/i.test(s.name || '');
    const m = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ color: isCourt ? 0xb3764a : 0x5f8a4a }));
    m.position.y = 0.07; scene.add(m);
  }
}

function windowTextures(baseColor) {
  // one tile = one floor (3.2 m) wide and tall; wall + emissive pair
  const tile = 128;
  const mk = (fn) => { const c = document.createElement('canvas'); c.width = c.height = tile;
    fn(c.getContext('2d'), tile); const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
  const col = '#' + baseColor.toString(16).padStart(6, '0');
  const map = mk((ctx, s) => {
    ctx.fillStyle = col; ctx.fillRect(0, 0, s, s);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, s - 6, s, 6);
    ctx.fillStyle = '#223142';
    for (let i = 0; i < 3; i++) ctx.fillRect(10 + i * 42, 34, 30, 52);
  });
  const emap = mk((ctx, s) => {
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, s, s);
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = Math.random() < 0.55 ? '#ffb354' : '#1a1a1a';
      ctx.fillRect(10 + i * 42, 34, 30, 52);
    }
  });
  return { map, emap };
}

function buildBuildings() {
  const byCat = {};
  for (const b of DATA.buildings) {
    const h = b.levels * FLOOR_H;
    const geo = new THREE.ExtrudeGeometry(shapeFromPoly(b.poly), { depth: h, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    // scale wall UVs: 1 uv unit = FLOOR_H metres so windows tile per floor
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) / FLOOR_H, uv.getY(i) / FLOOR_H);
    let wall = byCat[b.cat];
    if (!wall) {
      const { map, emap } = windowTextures(CAT_COLORS[b.cat] || CAT_COLORS.other);
      wall = byCat[b.cat] = new THREE.MeshLambertMaterial({ map, emissiveMap: emap, emissive: 0xffa64d, emissiveIntensity: 0 });
      wallMats.push(wall);
    }
    const roof = new THREE.MeshLambertMaterial({ color: 0x565b63 });
    const mesh = new THREE.Mesh(geo, [roof, wall]);
    mesh.userData.place = b.name || null;
    scene.add(mesh);
  }
}

function buildTrees() {
  const pts = [...DATA.trees];
  for (const row of DATA.treeRows)
    for (let i = 0; i < row.length - 1; i++) {
      const [ax, ay] = row[i], [bx, by] = row[i + 1];
      const d = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(d / 8));
      for (let k = 0; k < n; k++) pts.push([ax + (bx - ax) * k / n, ay + (by - ay) * k / n]);
    }
  if (!pts.length) return;
  const trunk = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.25, 0.35, 2.2, 5),
    new THREE.MeshLambertMaterial({ color: 0x5a4632 }), pts.length);
  const crown = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(2.4, 0),
    new THREE.MeshLambertMaterial({ color: 0x3e6b33 }), pts.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
  pts.forEach(([x, y], i) => {
    const s = 0.7 + Math.random() * 0.7;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI);
    m.compose(new THREE.Vector3(x, 1.1 * s, -y), q, sc.set(s, s, s)); trunk.setMatrixAt(i, m);
    m.compose(new THREE.Vector3(x, (2.2 + 1.8) * s, -y), q, sc.set(s, s * 1.15, s)); crown.setMatrixAt(i, m);
  });
  scene.add(trunk, crown);
}

function buildLamps() {
  const spots = [];
  for (const p of DATA.paths) {
    if (!p.walk) continue;
    let acc = 0;
    for (let i = 0; i < p.pts.length - 1; i++) {
      const [ax, ay] = p.pts[i], [bx, by] = p.pts[i + 1];
      const d = Math.hypot(bx - ax, by - ay);
      acc += d;
      if (acc > 28) { spots.push([bx, by]); acc = 0; }
    }
  }
  const pole = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.09, 0.11, 3.4, 4),
    new THREE.MeshLambertMaterial({ color: 0x2c2f34 }), spots.length);
  const m = new THREE.Matrix4();
  const glowPos = new Float32Array(spots.length * 3);
  spots.forEach(([x, y], i) => {
    m.setPosition(x, 1.7, -y); pole.setMatrixAt(i, m);
    glowPos.set([x, 3.5, -y], i * 3);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3));
  lampGlow = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xffd27a, size: 5, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false,
  }));
  lampPoints = spots.length;
  scene.add(pole, lampGlow);
}

function buildStars() {
  const n = 700, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2, e = Math.random() * 0.5 + 0.08, r = 1800;
    pos.set([Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r], i * 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  stars = new THREE.Points(geo, new THREE.PointsMaterial({
    color: 0xcdd8ff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false,
  }));
  scene.add(stars);
}

function buildRing() {
  ringMesh = new THREE.Mesh(
    new THREE.RingGeometry(6, 8, 40),
    new THREE.MeshBasicMaterial({ color: 0xffb454, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
  );
  ringMesh.rotation.x = -Math.PI / 2; ringMesh.position.y = 0.3; ringMesh.visible = false;
  scene.add(ringMesh);
}

/* ---------- routing ---------- */

function buildGraph() {
  const nodes = DATA.graph.nodes;
  const key = id => id;
  for (const [a, b] of DATA.graph.edges) {
    const pa = nodes[a], pb = nodes[b];
    if (!pa || !pb) continue;
    const w = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
    if (!adj.has(key(a))) adj.set(key(a), []);
    if (!adj.has(key(b))) adj.set(key(b), []);
    adj.get(key(a)).push([key(b), w]);
    adj.get(key(b)).push([key(a), w]);
  }
}

function nearestNode(x, y) {
  let best = null, bd = Infinity;
  for (const [id, [nx, ny]] of Object.entries(DATA.graph.nodes)) {
    const d = (nx - x) ** 2 + (ny - y) ** 2;
    if (d < bd) { bd = d; best = id; }
  }
  return best;
}

function astar(start, goal) {
  const nodes = DATA.graph.nodes;
  const g = new Map([[start, 0]]), f = new Map([[start, 0]]), came = new Map();
  const open = new Set([start]);
  const h = id => Math.hypot(nodes[id][0] - nodes[goal][0], nodes[id][1] - nodes[goal][1]);
  while (open.size) {
    let cur = null, bf = Infinity;
    for (const id of open) { const v = f.get(id) ?? Infinity; if (v < bf) { bf = v; cur = id; } }
    if (cur === goal) {
      const path = [cur];
      while (came.has(cur)) { cur = came.get(cur); path.unshift(cur); }
      return path;
    }
    open.delete(cur);
    for (const [nb, w] of adj.get(cur) || []) {
      const t = g.get(cur) + w;
      if (t < (g.get(nb) ?? Infinity)) {
        came.set(nb, cur); g.set(nb, t); f.set(nb, t + h(nb)); open.add(nb);
      }
    }
  }
  return null;
}

function showRoute(aPlace, bPlace) {
  clearRoute();
  const fromSel = document.getElementById('route-from'), toSel = document.getElementById('route-to');
  const opts = [...places].sort((a, b) => a.name.localeCompare(b.name));
  if (opts.includes(aPlace)) fromSel.selectedIndex = opts.indexOf(aPlace);
  if (opts.includes(bPlace)) toSel.selectedIndex = opts.indexOf(bPlace);
  const a = nearestNode(aPlace.x, -aPlace.z), b = nearestNode(bPlace.x, -bPlace.z);
  const info = document.getElementById('route-info');
  if (!a || !b) { info.textContent = 'No mapped paths near these places yet.'; return; }
  const path = astar(a, b);
  if (!path) { info.textContent = 'No connected mapped path between these yet - OSM coverage gap.'; return; }
  const pts = path.map(id => { const n = DATA.graph.nodes[id]; return [n[0], -n[1]]; });
  let dist = 0;
  for (let i = 1; i < pts.length; i++) dist += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  routeMesh = new THREE.Mesh(ribbon(pts, 2.2, 0.25),
    new THREE.MeshBasicMaterial({ color: 0x58c4ff, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
  scene.add(routeMesh);
  const mins = Math.round(dist / WALK_SPEED_MPM);
  info.innerHTML = `<strong>${Math.round(dist)} m</strong> &middot; about <strong>${mins} min</strong> walk (5 km/h, mapped paths only)`;
  const mx = (aPlace.x + bPlace.x) / 2, mz = (aPlace.z + bPlace.z) / 2;
  flyTo(mx, mz, Math.max(180, dist * 0.9));
}

function clearRoute() {
  if (routeMesh) { scene.remove(routeMesh); routeMesh.geometry.dispose(); routeMesh = null; }
}

/* ---------- places / search / labels ---------- */

function buildPlaces() {
  for (const b of DATA.buildings) {
    if (!b.name) continue;
    places.push({
      name: b.name, cat: CAT_LABEL[b.cat] || 'Building', x: b.c[0], z: -b.c[1],
      alt: ALT_NAMES[b.name] || null, kind: 'building',
      meta: `${CAT_LABEL[b.cat]} &middot; ${b.levels} floor${b.levels > 1 ? 's' : ''}${b.approxHeight ? ' (height approx.)' : ' (mapped)'}`,
    });
  }
  for (const s of DATA.sports) {
    if (!s.name || !s.c) continue;
    places.push({ name: s.name, cat: 'Sports', x: s.c[0], z: -s.c[1], alt: null, kind: 'sports', meta: 'Sports facility' });
  }
  for (const p of DATA.pois) {
    if (!p.c) continue;
    places.push({ name: p.name, cat: 'Place', x: p.c[0], z: -p.c[1], alt: null, kind: 'poi', meta: (p.kind || '').replace(/_/g, ' ') });
  }
  for (const p of places) {
    const sprite = makeLabel(p.alt ? `${p.name} · ${p.alt.split('(')[0].trim()}` : p.name);
    sprite.position.set(p.x, labelHeight(p), p.z);
    scene.add(sprite); labels.push(sprite); p.label = sprite;
  }
  // major landmarks stay readable far out; minor labels fade as you zoom away
  for (const p of places) {
    const major = p.kind === 'building' || /rock plaza|guest house|open-air|food/i.test(p.name);
    p.labelMaxDist = major ? 1000 : 420;
  }
}

function labelHeight(p) {
  if (p.kind === 'building') {
    const b = DATA.buildings.find(b => b.name === p.name);
    return (b ? b.levels * FLOOR_H : 10) + 9;
  }
  return 14;
}

function makeLabel(text) {
  const pad = 16, fs = 30;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
  c.width = Math.ceil(ctx.measureText(text).width) + pad * 2; c.height = 56;
  const ctx2 = c.getContext('2d');
  ctx2.fillStyle = 'rgba(10,14,24,0.72)';
  ctx2.beginPath(); ctx2.roundRect(0, 0, c.width, c.height, 12); ctx2.fill();
  ctx2.font = `600 ${fs}px "Segoe UI", system-ui, sans-serif`;
  ctx2.fillStyle = '#fff'; ctx2.textBaseline = 'middle';
  ctx2.fillText(text, pad, c.height / 2 + 1);
  const tex = new THREE.CanvasTexture(c);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const scale = 0.14;
  sp.scale.set(c.width * scale, c.height * scale, 1);
  sp.renderOrder = 10;
  return sp;
}

function searchPlaces(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  return places
    .map(p => {
      const hay = `${p.name} ${p.alt || ''} ${p.cat}`.toLowerCase();
      let score = -1;
      if (p.name.toLowerCase() === q) score = 100;
      else if (p.name.toLowerCase().startsWith(q)) score = 80;
      else if (hay.includes(q)) score = 50;
      else if (q.length >= 3) {
        // loose subsequence match so "cb" finds "Cricket Nets 1" too
        let i = 0; for (const ch of hay) if (ch === q[i]) i++;
        if (i >= q.length) score = 20;
      }
      return [p, score];
    })
    .filter(([, s]) => s >= 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([p]) => p);
}

/* ---------- camera / tour ---------- */

function flyTo(x, z, dist = 130, hgt = null, done) {
  const target = new THREE.Vector3(x, 0, z);
  const dir = camera.position.clone().sub(controls.target);
  dir.y = 0;
  if (dir.lengthSq() < 1) dir.set(0.6, 0, 1);
  dir.normalize();
  const h = hgt ?? dist * 0.75;
  const dest = target.clone().add(dir.multiplyScalar(dist)).add(new THREE.Vector3(0, h, 0));
  if (params.get('fast')) {
    camera.position.copy(dest); controls.target.copy(target); done && done(); return;
  }
  tweens.push({
    t: 0, dur: 1.5,
    fromP: camera.position.clone(), toP: dest,
    fromT: controls.target.clone(), toT: target, done,
  });
}

function tickTweens(dt) {
  for (const tw of tweens) {
    tw.t += dt / tw.dur;
    const k = tw.t >= 1 ? 1 : (tw.t < 0.5 ? 4 * tw.t ** 3 : 1 - Math.pow(-2 * tw.t + 2, 3) / 2);
    camera.position.lerpVectors(tw.fromP, tw.toP, k);
    controls.target.lerpVectors(tw.fromT, tw.toT, k);
  }
  const finished = tweens.filter(tw => tw.t >= 1);
  tweens = tweens.filter(tw => tw.t < 1);
  finished.forEach(tw => tw.done && tw.done());
}

const TOUR = [
  { at: null, cam: [60, 320, 560], text: '<b>VIT-AP University, Amaravati</b> - an unofficial 3D campus tour built from OpenStreetMap data. Drag to look around any time; Next moves on.' },
  { at: 'CB', text: '<b>CB - Central Block</b>: the campus landmark, mapped at 11 floors. The university lists key offices, departments, the library, an auditorium, a cafeteria and a health centre here.' },
  { at: 'AB-1', text: '<b>AB-1 - Sarvepalli Radhakrishnan Block</b>: major administrative offices (admissions, finance) and the VIT School of Business.' },
  { at: 'AB-2', text: '<b>AB-2 - APJ Abdul Kalam Block</b>: School of Sciences and Languages - maths, physics, languages - with classrooms and labs.' },
  { at: 'Food Street', text: '<b>Food Street</b>: the campus food court, mapped as its own building.' },
  { at: 'Rock Plaza', text: '<b>Rock Plaza</b>: open-air hangout and event spot near the centre of campus.' },
  { at: 'Sports Triangle 1', text: '<b>Sports Triangle</b>: basketball, volleyball and tennis courts grouped together.' },
  { at: 'Cricket Ground', text: '<b>Cricket Ground</b>: the main field, with practice nets alongside.' },
  { at: 'MH-2', text: '<b>Men\'s hostel blocks</b>: MH-1, MH-2, MH-3, MH-6 and MH-7 are mapped here, with a food store at MH-2.' },
  { at: 'LH-1', text: '<b>LH-1</b>: the mapped ladies\' hostel block.' },
  { at: 'Guest House', text: '<b>Guest House</b>: accommodation for campus visitors. End of tour - explore freely, or use Search and Route at the bottom.' },
];

function tourGo(i) {
  state.tour = i;
  const stop = TOUR[i];
  document.getElementById('tour-caption').innerHTML = stop.text;
  document.getElementById('tour-count').textContent = `${i + 1} / ${TOUR.length}`;
  if (stop.cam) {
    if (params.get('fast')) { camera.position.set(...stop.cam); controls.target.set(0, 10, 0); }
    else tweens.push({ t: 0, dur: 1.6, fromP: camera.position.clone(), toP: new THREE.Vector3(...stop.cam),
      fromT: controls.target.clone(), toT: new THREE.Vector3(0, 10, 0) });
    setRing(null);
  } else {
    const p = places.find(p => p.name === stop.at);
    if (p) { flyTo(p.x, p.z, 120); setRing(p); }
  }
}

function setRing(place) {
  if (!place) { ringMesh.visible = false; return; }
  ringMesh.position.set(place.x, 0.3, place.z);
  ringMesh.visible = true;
}

/* ---------- sun / sky ---------- */

function istHours(d) { return (d.getUTCHours() + d.getUTCMinutes() / 60 + 5.5) % 24; }

const SR = Math.PI / 180, DAYMS = 864e5, J1970 = 2440588, J2000 = 2451545, OBL = SR * 23.4397;
function sunPosition(date, lat, lon) {
  const d = date.valueOf() / DAYMS - 0.5 + J1970 - J2000;
  const M = SR * (357.5291 + 0.98560028 * d);
  const L = M + SR * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M)) + SR * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(L) * Math.sin(OBL));
  const ra = Math.atan2(Math.sin(L) * Math.cos(OBL), Math.cos(L));
  const H = SR * (280.16 + 360.9856235 * d) + SR * lon - ra;
  const phi = SR * lat;
  return {
    alt: Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)),
    az: Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)),
  };
}

function istDateForHour(hour) {
  const now = new Date();
  const utcMidnightIST = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0) - 5.5 * 3600e3;
  // find today's IST midnight in UTC, then add the hour
  const istNow = now.getTime() + 5.5 * 3600e3;
  const d = new Date(istNow);
  const istMidnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 5.5 * 3600e3;
  return new Date(istMidnight + hour * 3600e3);
}

const SKY = {
  night: new THREE.Color(0x101828), dawn: new THREE.Color(0xc96f3f), day: new THREE.Color(0x9cc8e8),
};

function updateSky() {
  const hour = state.hour;
  const date = state.live ? new Date() : istDateForHour(hour);
  const sun = sunPosition(date, DATA.center[0], DATA.center[1]);
  const alt = sun.alt;
  const dayF = THREE.MathUtils.smoothstep(alt, -0.04, 0.35);
  const dawnF = Math.max(0, 1 - Math.abs(alt) / 0.22) * 0.8;
  const nightF = 1 - dayF;

  const sky = SKY.night.clone().lerp(SKY.day, dayF).lerp(SKY.dawn, dawnF * (1 - dayF) + dawnF * 0.3);
  scene.background = sky;
  scene.fog = new THREE.Fog(sky.clone(), 700, 2400);

  const R = 900;
  sunLight.position.set(
    -Math.sin(sun.az) * Math.cos(alt) * R,
    Math.max(Math.sin(alt), 0.02) * R,
    Math.cos(sun.az) * Math.cos(alt) * R
  );
  sunLight.intensity = Math.max(Math.sin(alt), 0) * 1.5 + 0.02;
  sunLight.color.setHSL(0.1, 0.6, THREE.MathUtils.clamp(0.55 + Math.sin(alt) * 0.45, 0.55, 1));
  hemiLight.intensity = 0.34 + dayF * 0.62;

  const glow = THREE.MathUtils.clamp(nightF - 0.15, 0, 1);
  for (const m of wallMats) m.emissiveIntensity = glow * 1.15;
  if (lampGlow) lampGlow.material.opacity = glow * 0.95;
  if (stars) stars.material.opacity = glow;

  const hh = Math.floor(hour), mm = Math.round((hour - hh) * 60);
  const el = document.getElementById('timeread');
  if (el) el.textContent = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  const slider = document.getElementById('timeslider');
  if (slider && document.activeElement !== slider) slider.value = hour;
}

/* ---------- UI wiring ---------- */

function wireUI() {
  const $ = id => document.getElementById(id);
  const search = $('search'), suggest = $('suggest');
  let items = [], active = -1;

  const renderSuggest = list => {
    items = list; active = -1;
    suggest.innerHTML = '';
    for (const p of list) {
      const div = document.createElement('div');
      div.className = 'suggest-item';
      div.innerHTML = `<span>${p.name}${p.alt ? ` <span style="opacity:.65">&middot; ${p.alt}</span>` : ''}</span><span class="cat">${p.cat}</span>`;
      div.onclick = () => { selectPlace(p); suggest.classList.add('hidden'); search.blur(); };
      suggest.appendChild(div);
    }
    suggest.classList.toggle('hidden', !list.length);
  };
  search.addEventListener('input', () => renderSuggest(searchPlaces(search.value)));
  search.addEventListener('keydown', e => {
    if (e.key === 'Enter' && items.length) { selectPlace(items[Math.max(active, 0)]); suggest.classList.add('hidden'); }
    if (e.key === 'Escape') { suggest.classList.add('hidden'); search.blur(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(items.length, 1);
      [...suggest.children].forEach((el, i) => el.classList.toggle('active', i === active));
    }
  });
  document.addEventListener('click', e => { if (!e.target.closest('#searchbox')) suggest.classList.add('hidden'); });

  $('btn-labels').onclick = () => {
    state.labels = !state.labels;
    $('btn-labels').classList.toggle('on', state.labels);
  };
  $('btn-about').onclick = () => $('about').classList.remove('hidden');
  $('about-close').onclick = () => $('about').classList.add('hidden');
  $('btn-time').onclick = () => { $('timepanel').classList.toggle('hidden'); $('routepanel').classList.add('hidden'); };
  $('btn-route').onclick = () => { $('routepanel').classList.toggle('hidden'); $('timepanel').classList.add('hidden'); };

  $('timeslider').addEventListener('input', e => { state.live = false; state.hour = parseFloat(e.target.value); updateSky(); });
  $('timelive').onclick = () => { state.live = true; state.hour = istHours(new Date()); updateSky(); };

  const from = $('route-from'), to = $('route-to');
  const opts = [...places].sort((a, b) => a.name.localeCompare(b.name));
  for (const sel of [from, to]) {
    sel.innerHTML = opts.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
  }
  to.selectedIndex = Math.min(1, opts.length - 1);
  $('route-go').onclick = () => showRoute(opts[from.selectedIndex], opts[to.selectedIndex]);
  $('info-route').onclick = () => {
    if (!state.selected) return;
    $('routepanel').classList.remove('hidden');
    from.selectedIndex = opts.indexOf(state.selected);
    to.selectedIndex = (from.selectedIndex + 1) % opts.length;
    showRoute(opts[from.selectedIndex], opts[to.selectedIndex]);
  };

  $('btn-tour').onclick = () => {
    $('tourpanel').classList.remove('hidden');
    tourGo(0);
  };
  $('tour-next').onclick = () => tourGo(Math.min(state.tour + 1, TOUR.length - 1));
  $('tour-prev').onclick = () => tourGo(Math.max(state.tour - 1, 0));
  $('tour-exit').onclick = () => { $('tourpanel').classList.add('hidden'); state.tour = -1; };
  $('info-close').onclick = () => { $('infocard').classList.add('hidden'); setRing(null); state.selected = null; };

  if (!params.get('noabout')) $('about').classList.remove('hidden');
}

function selectPlace(p) {
  state.selected = p;
  $('infocard').classList.remove('hidden');
  $('info-name').textContent = p.alt ? `${p.name} - ${p.alt}` : p.name;
  $('info-meta').innerHTML = p.meta || p.cat;
  setRing(p);
  const b = DATA.buildings.find(b => b.name === p.name);
  const dist = b ? 90 + b.levels * 10 : 110;
  flyTo(p.x, p.z, dist);
}
const $ = id => document.getElementById(id);

/* ---------- debug / deterministic screenshot params ---------- */

function applyDebugParams() {
  if (params.get('cam')) {
    const v = params.get('cam').split(',').map(Number);
    if (v.length === 6) { camera.position.set(v[0], v[1], v[2]); controls.target.set(v[3], v[4], v[5]); }
  }
  const fly = params.get('fly');
  if (fly) {
    const p = places.find(p => p.name.toLowerCase().includes(fly.toLowerCase()));
    if (p) selectPlace(p);
  }
  const route = params.get('route');
  if (route) {
    const [a, b] = route.split('|');
    const pa = places.find(p => p.name.toLowerCase().includes((a || '').toLowerCase()));
    const pb = places.find(p => p.name.toLowerCase().includes((b || '').toLowerCase()));
    if (pa && pb) { $('routepanel').classList.remove('hidden'); showRoute(pa, pb); }
  }
  const tour = params.get('tour');
  if (tour !== null && tour !== undefined) {
    $('tourpanel').classList.remove('hidden');
    tourGo(Math.min(parseInt(tour) || 0, TOUR.length - 1));
  }
}

/* ---------- main loop ---------- */

let frames = 0;
function tick() {
  const dt = Math.min(clock.getDelta(), 0.1);
  tickTweens(dt);
  controls.update();
  if (state.live) {
    const h = istHours(new Date());
    if (Math.abs(h - state.hour) > 0.01) { state.hour = h; updateSky(); }
  }
  if (ringMesh.visible) {
    const s = 1 + Math.sin(performance.now() / 300) * 0.15;
    ringMesh.scale.set(s, s, 1);
  }
  for (const p of places) {
    if (!p.label) continue;
    const d = camera.position.distanceTo(p.label.position);
    const k = THREE.MathUtils.clamp((p.labelMaxDist - d) / 220, 0, 1);
    p.label.material.opacity = k;
    p.label.visible = state.labels && k > 0.02;
  }
  renderer.render(scene, camera);
  if (++frames === 3) window.__ready = true;
}

function onResize() {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}
