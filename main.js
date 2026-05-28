import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import earcut from 'earcut';
import { TrainSystem } from './train.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const CENTER_LAT = 35.6595;
const CENTER_LON = 139.7004;

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos(CENTER_LAT * Math.PI / 180);

const TILE_LAT    = 0.005;
const TILE_LON    = 0.006;
const LOAD_RADIUS = 2;

const FADE_NEAR   = 120;
const FADE_FAR    = 900;
const METRO_DEPTH = -7;
const EYE_HEIGHT  = 1.6;

// ─── Coordinate helpers ──────────────────────────────────────────────────────

function project(lat, lon) {
  return [
    (lon - CENTER_LON) * M_PER_DEG_LON,
    -(lat - CENTER_LAT) * M_PER_DEG_LAT,
  ];
}

function worldToGeo(x, z) {
  return {
    lat: CENTER_LAT - z / M_PER_DEG_LAT,
    lon: CENTER_LON + x / M_PER_DEG_LON,
  };
}

function latLonToTile(lat, lon) {
  return { tx: Math.floor(lon / TILE_LON), ty: Math.floor(lat / TILE_LAT) };
}

function tileToBBox(tx, ty) {
  return {
    south: ty * TILE_LAT,  north: (ty + 1) * TILE_LAT,
    west:  tx * TILE_LON,  east:  (tx + 1) * TILE_LON,
  };
}

// ─── Overpass ────────────────────────────────────────────────────────────────

async function fetchOSMBbox(bbox) {
  const { south, west, north, east } = bbox;
  const query = [
    '[out:json][timeout:40];(',
    `way["building"](${south},${west},${north},${east});`,
    `way["highway"](${south},${west},${north},${east});`,
    `way["railway"](${south},${west},${north},${east});`,
    ');out body;>;out skel qt;',
  ].join('');
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45_000);
  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'data=' + encodeURIComponent(query),
      signal:  ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    // Overpass returns 200 OK even on server-side timeout/error — detect via remark
    if (data.remark && /error|timeout/i.test(data.remark))
      throw new Error(`Overpass: ${data.remark}`);
    if (!Array.isArray(data.elements))
      throw new Error('Overpass: malformed response (no elements array)');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// ─── OSM parsing ─────────────────────────────────────────────────────────────

function buildNodeMap(osm) {
  const map = new Map();
  for (const el of osm.elements)
    if (el.type === 'node') map.set(el.id, project(el.lat, el.lon));
  return map;
}

function parseBuildings(osm, nodeMap) {
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags?.building) continue;
    const ring = el.nodes.map(id => nodeMap.get(id)).filter(Boolean);
    if (ring.length > 1) {
      const [ax, az] = ring[0], [bx, bz] = ring[ring.length - 1];
      if (ax === bx && az === bz) ring.pop();
    }
    if (ring.length < 3) continue;
    out.push({ id: el.id, ring, height: extractHeight(el.tags) });
  }
  return out;
}

function extractHeight(tags) {
  for (const key of ['height', 'building:height']) {
    if (tags[key]) { const v = parseFloat(tags[key]); if (v > 0) return v; }
  }
  if (tags['building:levels']) {
    const l = parseInt(tags['building:levels'], 10);
    if (l > 0) return l * 3.5;
  }
  return 10;
}

const HIGHWAY_SKIP = new Set([
  'proposed','construction','elevator','steps','corridor','platform','raceway',
]);

function parseStreets(osm, nodeMap) {
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags?.highway) continue;
    if (HIGHWAY_SKIP.has(el.tags.highway)) continue;
    const coords = el.nodes.map(id => nodeMap.get(id)).filter(Boolean);
    if (coords.length < 2) continue;
    out.push({ id: el.id, coords, highway: el.tags.highway });
  }
  return out;
}

const RAILWAY_TYPES = new Set(['rail','subway','light_rail','monorail','tram']);

function parseRailways(osm, nodeMap) {
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags?.railway) continue;
    if (!RAILWAY_TYPES.has(el.tags.railway)) continue;
    const coords = el.nodes.map(id => nodeMap.get(id)).filter(Boolean);
    if (coords.length < 2) continue;
    const isBridge = el.tags.bridge === 'yes' || el.tags.bridge === 'viaduct';
    const isTunnel = el.tags.tunnel === 'yes' || (el.tags.railway === 'subway' && !isBridge);
    out.push({ id: el.id, coords, type: el.tags.railway, isTunnel });
  }
  return out;
}

// ─── Colour palette ───────────────────────────────────────────────────────────

function heightColor(h) {
  const t = Math.min(h / 150, 1);
  return new THREE.Color().setHSL(
    220 / 360,
    t * 0.55,
    0.78 - t * 0.26,
  );
}

function wireColor(h) {
  const t = Math.min(h / 150, 1);
  return new THREE.Color().setHSL(
    220 / 360,
    t * 0.60,
    0.32 - t * 0.12,
  );
}

const FOOT_TYPES = new Set(['footway','path','pedestrian','cycleway','bridleway']);

function streetColor(type) {
  if (FOOT_TYPES.has(type)) return new THREE.Color(0xd0c4a8);  // tan — footpaths/sidewalks
  return new THREE.Color(0x909090);                             // neutral grey — roads
}

function railColor(type) {
  switch (type) {
    case 'rail':       return new THREE.Color(0x80b830);
    case 'subway':     return new THREE.Color(0x22aa55);
    case 'light_rail': return new THREE.Color(0x00aacc);
    case 'tram':       return new THREE.Color(0xcc8800);
    case 'monorail':   return new THREE.Color(0x009988);
    default:           return new THREE.Color(0x667799);
  }
}

// ─── Shaders ─────────────────────────────────────────────────────────────────

const SURF_VERT = /* glsl */`
  attribute vec3 color;
  varying vec3  vCol;
  varying float vDist;
  varying vec3  vNorm;
  void main() {
    vCol  = color;
    vNorm = normalMatrix * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const SURF_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  varying vec3  vNorm;
  uniform float uNear;
  uniform float uFar;
  void main() {
    vec3  L     = normalize(vec3(0.5, 1.0, 0.3));
    float diff  = max(dot(normalize(vNorm), L), 0.0);
    float light = 0.60 + 0.40 * diff;
    float fade  = 1.0 - smoothstep(uNear, uFar, vDist);
    float a     = 0.80 * fade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vCol * light, a);
  }
`;

const LINE_VERT = /* glsl */`
  attribute vec3 color;
  varying vec3  vCol;
  varying float vDist;
  void main() {
    vCol = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const WIRE_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float fade = 1.0 - smoothstep(uNear, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, fade);
  }
`;

const STREET_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float fade = 1.0 - smoothstep(uNear, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.5 * fade);
  }
`;

const METRO_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float fade = 1.0 - smoothstep(uNear * 0.5, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.05 * fade);
  }
`;

function fadeUniforms() {
  return { uNear: { value: FADE_NEAR }, uFar: { value: FADE_FAR } };
}

function createMaterials() {
  return {
    surface: new THREE.ShaderMaterial({
      vertexShader: SURF_VERT, fragmentShader: SURF_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
      side: THREE.DoubleSide,
    }),
    wireframe: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: WIRE_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
    }),
    street: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: STREET_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
    }),
    rail: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: STREET_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
    }),
    metro: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: METRO_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
      depthTest: false, side: THREE.DoubleSide,
    }),
  };
}

// ─── Geometry builders ───────────────────────────────────────────────────────

function buildSingleBuildingGeo(ring, height) {
  const pos = [], norm = [], idx = [];
  let v = 0;
  const n = ring.length;
  const flat = ring.flatMap(([x, z]) => [x, z]);
  const tris = earcut(flat);
  if (!tris.length) return null;

  const rb = v;
  for (const [x, z] of ring) { pos.push(x, height, z); norm.push(0, 1, 0); v++; }
  for (const i of tris) idx.push(rb + i);

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, z0] = ring[i], [x1, z1] = ring[j];
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
    const b = v;
    pos.push(x0, 0, z0,  x1, 0, z1,  x1, height, z1,  x0, height, z0);
    for (let k = 0; k < 4; k++) norm.push(dz / len, 0, -dx / len);
    idx.push(b, b+1, b+2,  b, b+2, b+3);
    v += 4;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,  3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(norm, 3));
  geo.setIndex(idx);
  return geo;
}

function buildSurfaceMesh(buildings, mat) {
  const pos = [], norm = [], col = [], idx = [];
  let v = 0;

  for (const { ring, height } of buildings) {
    const n  = ring.length;
    const rc = heightColor(height);
    const wc = rc.clone().multiplyScalar(0.55);
    const flat = ring.flatMap(([x, z]) => [x, z]);
    const tris = earcut(flat);
    if (!tris.length) continue;

    const rb = v;
    for (const [x, z] of ring) {
      pos.push(x, height, z); norm.push(0, 1, 0); col.push(rc.r, rc.g, rc.b); v++;
    }
    for (const i of tris) idx.push(rb + i);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [x0, z0] = ring[i], [x1, z1] = ring[j];
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
      const b = v;
      pos.push(x0, 0, z0,  x1, 0, z1,  x1, height, z1,  x0, height, z0);
      for (let k = 0; k < 4; k++) { norm.push(dz / len, 0, -dx / len); col.push(wc.r, wc.g, wc.b); }
      idx.push(b, b+1, b+2,  b, b+2, b+3);
      v += 4;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos,  3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(norm, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col,  3));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  return mesh;
}

function buildEdgesGeoMesh(buildings, mat) {
  const allPos = [], allCol = [];

  for (const { ring, height } of buildings) {
    const base = buildSingleBuildingGeo(ring, height);
    if (!base) continue;
    const edgesGeo = new THREE.EdgesGeometry(base);
    const posAttr  = edgesGeo.getAttribute('position');
    const c = wireColor(height);
    for (let i = 0; i < posAttr.count; i++) {
      allPos.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      allCol.push(c.r, c.g, c.b);
    }
    base.dispose();
    edgesGeo.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(allCol, 3));
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 2;
  return lines;
}

function buildStreetLines(streets, mat) {
  const rPos = [], rCol = [];  // vehicle roads
  const fPos = [], fCol = [];  // footpaths

  for (const { coords, highway } of streets) {
    const c     = streetColor(highway);
    const foot  = FOOT_TYPES.has(highway);
    const pos   = foot ? fPos : rPos;
    const col   = foot ? fCol : rCol;
    const halfW = foot ? 1.5 : 3.5;  // footpath 3m wide, road 7m wide

    for (let i = 0; i < coords.length - 1; i++) {
      const [x0, z0] = coords[i];
      const [x1, z1] = coords[i + 1];
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = -dz / len * halfW;
      const nz =  dx / len * halfW;
      // Quad as two CCW triangles, normal faces up so front-face visible from above
      pos.push(
        x0 - nx, 0.05, z0 - nz,
        x0 + nx, 0.05, z0 + nz,
        x1 - nx, 0.05, z1 - nz,
        x1 + nx, 0.05, z1 + nz,
        x1 - nx, 0.05, z1 - nz,
        x0 + nx, 0.05, z0 + nz,
      );
      for (let v = 0; v < 6; v++) col.push(c.r, c.g, c.b);
    }
  }

  const result = [];
  function make(pos, col, ro) {
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = ro;
    result.push(mesh);
  }
  make(fPos, fCol, 1);  // footpaths between ground and buildings
  make(rPos, rCol, 3);  // roads above buildings
  return result;
}

function buildRailLines(rails, yLevel, mat) {
  const pos = [], col = [];
  for (const { coords, type } of rails) {
    const c = railColor(type);
    for (let i = 0; i < coords.length - 1; i++) {
      const [x0, z0] = coords[i], [x1, z1] = coords[i + 1];
      pos.push(x0, yLevel, z0,  x1, yLevel, z1);
      col.push(c.r, c.g, c.b,   c.r, c.g, c.b);
    }
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  return new THREE.LineSegments(geo, mat);
}

// Returns { mesh, curves } — curves are at METRO_DEPTH, same as tube geometry.
// Train cars use depthTest:false so they render through the ground plane.
function buildMetroTubes(rails, mat) {
  const geoms  = [];
  const curves = [];

  for (const { coords, type } of rails) {
    if (coords.length < 2) continue;
    const pts = [];
    for (const [x, z] of coords) {
      const v = new THREE.Vector3(x, METRO_DEPTH, z);
      if (!pts.length || v.distanceTo(pts[pts.length - 1]) > 0.1) pts.push(v);
    }
    if (pts.length < 2) continue;

    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    curves.push(curve);

    const geo   = new THREE.TubeGeometry(curve, Math.max(pts.length * 2, 4), 2.5, 8, false);
    const c      = railColor(type);
    const count  = geo.getAttribute('position').count;
    const colBuf = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colBuf[i * 3] = c.r; colBuf[i * 3 + 1] = c.g; colBuf[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colBuf, 3));
    geoms.push(geo);
  }

  if (!geoms.length) return null;
  const merged = mergeGeometries(geoms);
  geoms.forEach(g => g.dispose());
  const mesh = new THREE.Mesh(merged, mat);
  mesh.renderOrder = 3;
  return { mesh, curves };
}

// ─── Curve stitching ─────────────────────────────────────────────────────────
// Greedy closest-endpoint matching builds long continuous paths from many
// short per-tile segments. All input curves share y=1.9 so distance is XZ only.
function stitchMetroCurves(curves) {
  const THRESH = 60;   // metres — connect endpoints within this distance
  const used   = new Set();
  const result = [];

  // Direction of a point-array at its tail (looking back up to 5 points for stability).
  function tailDir(pts) {
    const end = pts[pts.length - 1];
    for (let i = pts.length - 2; i >= Math.max(0, pts.length - 5); i--) {
      const v = new THREE.Vector3().subVectors(end, pts[i]);
      if (v.length() > 0.5) return v.normalize();
    }
    return null;
  }

  // Find the best unvisited neighbour whose outgoing direction is forward-compatible.
  function bestNeighbour(anchor, anchorDir) {
    let bestJ = -1, bestDist = THRESH, bestFlip = false;
    for (let j = 0; j < curves.length; j++) {
      if (used.has(j)) continue;
      const jp = curves[j].points;
      if (Math.abs(anchor.y - jp[0].y) > 2 && Math.abs(anchor.y - jp[jp.length - 1].y) > 2) continue;

      const d0 = anchor.distanceTo(jp[0]);
      const d1 = anchor.distanceTo(jp[jp.length - 1]);
      const last = jp.length - 1;

      // Not flipped: new segment goes jp[0] → jp[1]
      if (d0 < bestDist) {
        let ok = true;
        if (anchorDir && jp.length >= 2) {
          const out = new THREE.Vector3().subVectors(jp[1], jp[0]);
          if (out.length() > 0.01 && anchorDir.dot(out.normalize()) <= 0) ok = false;
        }
        if (ok) { bestDist = d0; bestJ = j; bestFlip = false; }
      }
      // Flipped: new segment (reversed) goes jp[last] → jp[last-1]
      if (d1 < bestDist) {
        let ok = true;
        if (anchorDir && jp.length >= 2) {
          const out = new THREE.Vector3().subVectors(jp[last - 1], jp[last]);
          if (out.length() > 0.01 && anchorDir.dot(out.normalize()) <= 0) ok = false;
        }
        if (ok) { bestDist = d1; bestJ = j; bestFlip = true; }
      }
    }
    return bestJ >= 0 ? { j: bestJ, flip: bestFlip } : null;
  }

  for (let seed = 0; seed < curves.length; seed++) {
    if (used.has(seed)) continue;
    used.add(seed);
    let pts = curves[seed].points.slice();

    let match;
    while ((match = bestNeighbour(pts[pts.length - 1], tailDir(pts)))) {
      const jp = curves[match.j].points;
      pts = pts.concat(match.flip ? jp.slice().reverse().slice(1) : jp.slice(1));
      used.add(match.j);
    }

    result.push(new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5));
  }

  return result;
}

// Split a stitched curve wherever consecutive segments form an angle > ~60°
// (dot < 0.5) so trains always move in a smooth forward arc.
function splitAtSharpTurns(curve) {
  const pts = curve.points;
  if (pts.length < 3) return [curve];

  const segs  = [];
  let   seg   = [pts[0]];

  for (let i = 1; i < pts.length - 1; i++) {
    seg.push(pts[i]);
    const a = new THREE.Vector3().subVectors(pts[i],     pts[i - 1]).normalize();
    const b = new THREE.Vector3().subVectors(pts[i + 1], pts[i]    ).normalize();
    if (a.dot(b) < 0.5) {        // angle > ~60° — split here
      if (seg.length >= 2) segs.push(new THREE.CatmullRomCurve3(seg, false, 'centripetal', 0.5));
      seg = [pts[i]];
    }
  }
  seg.push(pts[pts.length - 1]);
  if (seg.length >= 2) segs.push(new THREE.CatmullRomCurve3(seg, false, 'centripetal', 0.5));

  return segs.length ? segs : [curve];
}

// ─── Collision ───────────────────────────────────────────────────────────────

function pointInPolygon(px, pz, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > pz) !== (zj > pz) && px < (xj - xi) * (pz - zi) / (zj - zi) + xi)
      inside = !inside;
  }
  return inside;
}

// ─── Tile manager ────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

class TileManager {
  constructor(scene, mats, statusEl) {
    this.scene      = scene;
    this.mats       = mats;
    this.statusEl   = statusEl;
    this.tiles      = new Map();
    this.queue      = [];
    this.seenIds    = new Set();
    this.buildings  = 0;
    this.streets    = 0;
    this.rails      = 0;
    this.busy       = false;
    this.footprints = [];   // { ring, minX, maxX, minZ, maxZ }
    this.tilesTotal   = 0;
    this.tilesLoaded  = 0;
    this._retries     = new Map(); // k → retry count
    this.metroCurves  = [];   // CatmullRomCurve3 paths collected as tiles load
  }

  key(tx, ty) { return `${tx}_${ty}`; }

  request(tx, ty) {
    const k = this.key(tx, ty);
    if (this.tiles.has(k)) return;
    this.tiles.set(k, 'queued');
    this.queue.push({ tx, ty, k });
  }

  update(camX, camZ) {
    const { lat, lon } = worldToGeo(camX, camZ);
    const { tx, ty }   = latLonToTile(lat, lon);
    this.request(tx, ty);
    for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++)
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++)
        if (dx || dy) this.request(tx + dx, ty + dy);
    if (!this.busy && this.queue.length) this._process();
  }

  async _process() {
    this.busy = true;
    while (this.queue.length) {
      const { tx, ty, k } = this.queue.shift();
      this.tiles.set(k, 'loading');
      await this._loadTile(tx, ty, k);
      if (this.queue.length) await sleep(350);
    }
    this.busy = false;
  }

  async _loadTile(tx, ty, k) {
    try {
      const osm     = await fetchOSMBbox(tileToBBox(tx, ty));
      const nodeMap = buildNodeMap(osm);

      const bldgs = parseBuildings(osm, nodeMap)
        .filter(b => { if (this.seenIds.has(b.id)) return false; this.seenIds.add(b.id); return true; });
      const strs  = parseStreets(osm, nodeMap)
        .filter(s => { if (this.seenIds.has(s.id)) return false; this.seenIds.add(s.id); return true; });
      const rails = parseRailways(osm, nodeMap)
        .filter(r => { if (this.seenIds.has(r.id)) return false; this.seenIds.add(r.id); return true; });

      // Register footprints for collision
      for (const { ring, height } of bldgs) {
        const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
        this.footprints.push({
          ring, height,
          minX: Math.min(...xs), maxX: Math.max(...xs),
          minZ: Math.min(...zs), maxZ: Math.max(...zs),
        });
      }

      const group = new THREE.Group();
      if (bldgs.length) {
        group.add(buildSurfaceMesh(bldgs, this.mats.surface));
        group.add(buildEdgesGeoMesh(bldgs, this.mats.wireframe));
        this.buildings += bldgs.length;
      }
      if (strs.length) {
        for (const m of buildStreetLines(strs, this.mats.street)) group.add(m);
        this.streets += strs.length;
      }
      if (rails.length) {
        const surface = rails.filter(r => !r.isTunnel);
        const tunnel  = rails.filter(r =>  r.isTunnel);
        const sl = buildRailLines(surface, 0.3, this.mats.rail);
        const tl = buildMetroTubes(tunnel, this.mats.metro);
        if (sl) { sl.renderOrder = 0; group.add(sl); }
        if (tl) {
          group.add(tl.mesh);
          for (const c of tl.curves) this.metroCurves.push(c);
        }
        // Surface-rail trains at car-centre height (y=1.9) — always visible
        // from ground level as a guaranteed fallback alongside tunnel trains.
        for (const { coords } of surface) {
          if (coords.length < 2) continue;
          const pts = [];
          for (const [x, z] of coords) {
            const v = new THREE.Vector3(x, 1.9, z);
            if (!pts.length || v.distanceTo(pts[pts.length - 1]) > 0.1) pts.push(v);
          }
          if (pts.length >= 2)
            this.metroCurves.push(new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5));
        }
        this.rails += rails.length;
      }

      this.scene.add(group);
      this.tiles.set(k, 'done');
      this._updateStatus();
    } catch (err) {
      console.warn(`Tile ${tx},${ty}:`, err.message);
      this.tiles.set(k, 'failed');
      // Retry up to 5× with capped back-off: 3 s, 5 s, 8 s, 12 s, 12 s
      const attempt = this._retries.get(k) || 0;
      if (attempt < 5) {
        this._retries.set(k, attempt + 1);
        const delay = [3000, 5000, 8000, 12000, 12000][attempt];
        setTimeout(() => {
          this.tiles.delete(k);
          this.request(tx, ty);
          if (!this.busy) this._process();
        }, delay);
        return; // don't count as done yet — retry is in flight
      }
    }
    this.tilesLoaded++;
  }

  isInBuilding(x, z, playerY, R = 0.8) {
    for (const fp of this.footprints) {
      if (fp.height < playerY) continue; // eye level above roof = can pass over
      if (x + R < fp.minX || x - R > fp.maxX || z + R < fp.minZ || z - R > fp.maxZ) continue;
      if (pointInPolygon(x, z, fp.ring)) return true;
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        if (pointInPolygon(x + R * Math.cos(a), z + R * Math.sin(a), fp.ring)) return true;
      }
    }
    return false;
  }

  // Returns the height of the tallest building footprint under (x, z), or 0 for open ground
  getFloorHeight(x, z) {
    let maxH = 0;
    for (const fp of this.footprints) {
      if (x < fp.minX || x > fp.maxX || z < fp.minZ || z > fp.maxZ) continue;
      if (fp.height > maxH && pointInPolygon(x, z, fp.ring)) maxH = fp.height;
    }
    return maxH;
  }

  _updateStatus() {
    const queued = this.queue.length;
    let text = `${this.buildings.toLocaleString()} buildings · ${this.streets.toLocaleString()} streets`;
    if (this.rails) text += ` · ${this.rails} rail segments`;
    if (queued) text += ` · ${queued} tile${queued > 1 ? 's' : ''} queued`;
    this.statusEl.textContent = text;
  }

  get hasData() { return this.buildings > 0; }
}

// ─── First-person controls ───────────────────────────────────────────────────

function createFPSControls(camera, domElement, collision) {
  let yaw   = 0;
  let pitch = 0;

  const LOOK_SPEED   = 0.00175;
  const MOVE_SPEED   = 0.30;
  const STRAFE_SPEED = 0.15;
  const JUMP_VEL     = 0.20;
  const GRAVITY      = -0.012;

  let velocityY  = 0;
  let isGrounded = true;

  const keys = new Set();
  window.addEventListener('keydown', e => { keys.add(e.code); if (e.code === 'Space') e.preventDefault(); });
  window.addEventListener('keyup',   e => keys.delete(e.code));

  const _fwd   = new THREE.Vector3();
  const _right = new THREE.Vector3();

  function applyRotation() {
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  }

  function getHorizDirs() {
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _fwd.y = 0; _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
  }

  // On ground use 0.8 m margin; airborne drop to 0 so the gap can't trap you.
  function tryMove(dx, dz) {
    const R  = isGrounded ? 0.8 : 0.0;
    const cx = camera.position.x, cz = camera.position.z, cy = camera.position.y;
    const blocked = collision.fn && collision.fn(cx + dx, cz + dz, cy, R);
    if (!blocked) {
      camera.position.x += dx;
      camera.position.z += dz;
    } else {
      if (!collision.fn(cx + dx, cz, cy, R))      camera.position.x += dx;
      else if (!collision.fn(cx, cz + dz, cy, R)) camera.position.z += dz;
    }
  }

  // Pointer lock — click canvas to capture, Escape releases automatically.
  domElement.addEventListener('click', () => {
    if (document.pointerLockElement !== domElement) domElement.requestPointerLock();
  });

  document.addEventListener('mousemove', e => {
    if (document.pointerLockElement !== domElement) return;
    yaw  += -e.movementX * LOOK_SPEED;
    pitch = Math.max(-Math.PI * 0.499, Math.min(Math.PI * 0.499, pitch + -e.movementY * LOOK_SPEED));
    applyRotation();
    dispatcher.dispatchEvent({ type: 'change' });
  });

  domElement.addEventListener('contextmenu', e => e.preventDefault());

  // Touch look (for mobile — no pointer lock available)
  let touchLast = null;
  domElement.addEventListener('touchstart', e => {
    if (e.touches.length === 1) touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    e.preventDefault();
  }, { passive: false });
  domElement.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && touchLast) {
      const dx = e.touches[0].clientX - touchLast.x, dy = e.touches[0].clientY - touchLast.y;
      touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      yaw  += -dx * LOOK_SPEED;
      pitch = Math.max(-Math.PI * 0.499, Math.min(Math.PI * 0.499, pitch + -dy * LOOK_SPEED));
      applyRotation();
      dispatcher.dispatchEvent({ type: 'change' });
    }
    e.preventDefault();
  }, { passive: false });
  domElement.addEventListener('touchend', () => { touchLast = null; });

  const dispatcher = Object.assign(new THREE.EventDispatcher(), {
    update() {
      // Physics
      const floorY = (collision.floorFn ? collision.floorFn(camera.position.x, camera.position.z) : 0) + EYE_HEIGHT;
      if (keys.has('Space')) {
        velocityY = JUMP_VEL;
      } else if (camera.position.y > floorY) {
        velocityY += GRAVITY;
      } else {
        velocityY = 0;
      }
      camera.position.y = Math.max(floorY, camera.position.y + velocityY);
      isGrounded = camera.position.y <= floorY + 0.05;

      // WASD + Shift sprint
      if (keys.has('KeyW') || keys.has('KeyS') || keys.has('KeyA') || keys.has('KeyD')) {
        getHorizDirs();
        const sprint = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 2 : 1;
        let moved = false;
        if (keys.has('KeyW')) { tryMove( _fwd.x * MOVE_SPEED * sprint,     _fwd.z * MOVE_SPEED * sprint);    moved = true; }
        if (keys.has('KeyS')) { tryMove(-_fwd.x * MOVE_SPEED * sprint,    -_fwd.z * MOVE_SPEED * sprint);    moved = true; }
        if (keys.has('KeyD')) { tryMove( _right.x * STRAFE_SPEED * sprint,  _right.z * STRAFE_SPEED * sprint); moved = true; }
        if (keys.has('KeyA')) { tryMove(-_right.x * STRAFE_SPEED * sprint, -_right.z * STRAFE_SPEED * sprint); moved = true; }
        if (moved) dispatcher.dispatchEvent({ type: 'change' });
      }
    },
  });

  return dispatcher;
}

// ─── Scene setup ─────────────────────────────────────────────────────────────

function initScene(collision) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0); // transparent — sky comes from CSS gradient
  document.body.appendChild(renderer.domElement);

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, innerWidth / innerHeight, 0.15, 2000);
  camera.position.set(0, 1.6, 0);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000, 1, 1),
    new THREE.ShaderMaterial({
      uniforms: {
        uGround: { value: new THREE.Color(0xd0c4a8) },
        uFar:    { value: FADE_FAR },
      },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */`
        varying vec2 vXZ;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vXZ = world.xz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3  uGround;
        uniform float uFar;
        varying vec2  vXZ;
        void main() {
          float d     = length(vXZ - cameraPosition.xz);
          float alpha = 1.0 - smoothstep(uFar * 0.5, uFar, d);
          if (alpha < 0.01) discard;
          gl_FragColor = vec4(uGround, alpha);
        }
      `,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  ground.renderOrder = -1; // render before streets/buildings so they always paint over it
  scene.add(ground);

  const controls = createFPSControls(camera, renderer.domElement, collision);

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  const trainRef = { system: null };
  let lastTime = performance.now();

  (function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.1);
    lastTime  = now;
    controls.update();
    if (trainRef.system) trainRef.system.update(dt);
    renderer.render(scene, camera);
  })();

  return { scene, camera, controls, trainRef };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const loadMsg  = document.getElementById('load-msg');
  const statusEl = document.getElementById('status');

  // Mutable ref so controls (created first) can call collision once tiles arrive
  const collision = { fn: null };
  const { scene, camera, controls, trainRef } = initScene(collision);

  loadMsg.textContent = 'Fetching Shibuya from OpenStreetMap…';

  const mats    = createMaterials();
  const manager = new TileManager(scene, mats, statusEl);

  // Wire collision after manager exists
  collision.fn      = (x, z, y, R) => manager.isInBuilding(x, z, y, R);
  collision.floorFn = (x, z)    => manager.getFloorHeight(x, z);

  manager.update(0, 0);
  manager.tilesTotal = manager.queue.length;  // capture initial batch size
  const TILES_CORE   = Math.min(9, manager.tilesTotal); // show until 3×3 core is done
  // Track the center tile so we don't dismiss the loading screen until it's ready.
  const _cg = worldToGeo(0, 0);
  const _ct = latLonToTile(_cg.lat, _cg.lon);
  const centerKey = manager.key(_ct.tx, _ct.ty);

  let lastCheck = 0;
  controls.addEventListener('change', () => {
    const now = Date.now();
    if (now - lastCheck > 2000) {
      lastCheck = now;
      manager.update(camera.position.x, camera.position.z);
    }
  });

  const pbar    = document.getElementById('pbar');
  const loadMsg2 = document.getElementById('load-msg');
  const loading = document.getElementById('loading');
  let shown = false;
  const poll = setInterval(() => {
    if (shown) return;
    const pct = Math.min(1, manager.tilesLoaded / TILES_CORE);
    pbar.style.width = `${pct * 100}%`;

    const centerStatus = manager.tiles.get(centerKey);
    const centerReady  = centerStatus === 'done' || centerStatus === 'failed';
    if (manager.hasData && centerReady) {
      // We have real buildings and the center tile is resolved — show the scene
      shown = true;
      clearInterval(poll);
      loading.classList.add('fade-out');
      setTimeout(() => loading.remove(), 800);
      if (manager.metroCurves.length) {
        const stitched = stitchMetroCurves(manager.metroCurves);
        const cleaned  = stitched.flatMap(splitAtSharpTurns);
        trainRef.system = new TrainSystem(scene, cleaned);
      }
    } else if (manager.tilesLoaded >= TILES_CORE) {
      // Core tiles all finished (possibly with errors) but no data yet —
      // retries are in flight; let user know
      loadMsg2.textContent = 'Retrying…';
    }
  }, 200);
}

main();
