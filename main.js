import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import earcut from 'earcut';
import { TrainSystem } from './train.js';

// ─── Config ──────────────────────────────────────────────────────────────────

// Center of the world (world origin maps here). Mutable: set from the geocoded
// start location chosen on the loading screen before any geometry loads.
let CENTER_LAT = 35.6595;
let CENTER_LON = 139.7004;

const M_PER_DEG_LAT = 111_320;
let   M_PER_DEG_LON = 111_320 * Math.cos(CENTER_LAT * Math.PI / 180);

function setCenter(lat, lon) {
  CENTER_LAT = lat;
  CENTER_LON = lon;
  M_PER_DEG_LON = 111_320 * Math.cos(CENTER_LAT * Math.PI / 180);
}

const TILE_LAT    = 0.005;
const TILE_LON    = 0.006;
const LOAD_RADIUS = 2;

const FADE_NEAR   = 120;
const FADE_FAR    = 900;
const METRO_DEPTH = -7;
const EYE_HEIGHT  = 1.6;
// Sink the ground mesh this far below true terrain so its coarse triangles can
// never poke up through the thin road/footpath decals laid just above terrain.
const GROUND_SINK = 0.6;

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

// ─── Terrain elevation (Terrarium tiles, AWS S3) ──────────────────────────────

let terrain = null;
const TERRAIN_ZOOM = 12;

function terrainTX(lon, z) { return Math.floor((lon + 180) / 360 * (1 << z)); }
function terrainTY(lat, z) {
  const r = lat * Math.PI / 180;
  return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * (1 << z));
}

class TerrainSampler {
  constructor(tiles, baseElev) {
    this.tiles = tiles;
    this.baseElev = baseElev;
  }

  sampleLatLon(lat, lon) {
    const r = lat * Math.PI / 180;
    const sec = 1 / Math.cos(r);
    for (const t of this.tiles) {
      const n = 1 << t.z;
      const fx = (lon + 180) / 360 * n - t.tx;
      const fy = (1 - Math.log(Math.tan(r) + sec) / Math.PI) / 2 * n - t.ty;
      if (fx < 0 || fx >= 1 || fy < 0 || fy >= 1) continue;
      const px = fx * t.w, py = fy * t.h;
      const x0 = Math.min(Math.floor(px), t.w - 2);
      const y0 = Math.min(Math.floor(py), t.h - 2);
      const u = px - x0, v = py - y0;
      const h = (xi, yi) => {
        const i = (yi * t.w + xi) * 4;
        return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
      };
      return h(x0,y0)*(1-u)*(1-v) + h(x0+1,y0)*u*(1-v) +
             h(x0,y0+1)*(1-u)*v   + h(x0+1,y0+1)*u*v;
    }
    return this.baseElev;
  }

  // Returns elevation in metres relative to world origin (positive = higher than spawn).
  sample(wx, wz) {
    const { lat, lon } = worldToGeo(wx, wz);
    return this.sampleLatLon(lat, lon) - this.baseElev;
  }
}

async function loadTerrain() {
  const extra = LOAD_RADIUS + 1;
  const bounds = {
    s: CENTER_LAT - extra * TILE_LAT, n: CENTER_LAT + extra * TILE_LAT,
    w: CENTER_LON - extra * TILE_LON, e: CENTER_LON + extra * TILE_LON,
  };
  const txMin = terrainTX(bounds.w, TERRAIN_ZOOM), txMax = terrainTX(bounds.e, TERRAIN_ZOOM);
  const tyMin = terrainTY(bounds.n, TERRAIN_ZOOM), tyMax = terrainTY(bounds.s, TERRAIN_ZOOM);

  const fetches = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      fetches.push(new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
          const c = document.createElement('canvas');
          c.width = img.width; c.height = img.height;
          const ctx2 = c.getContext('2d');
          ctx2.drawImage(img, 0, 0);
          const { data } = ctx2.getImageData(0, 0, img.width, img.height);
          resolve({ data, w: img.width, h: img.height, z: TERRAIN_ZOOM, tx, ty });
        };
        img.onerror = () => resolve(null);
        img.src = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${tx}/${ty}.png`;
      }));
    }
  }

  const tiles = (await Promise.all(fetches)).filter(Boolean);
  if (!tiles.length) return null;
  const tmp = new TerrainSampler(tiles, 0);
  const baseElev = tmp.sampleLatLon(CENTER_LAT, CENTER_LON);
  return new TerrainSampler(tiles, baseElev);
}

// Returns { topY, vertexH } for a building.
// topY = flat roof elevation, measured as (highest terrain under the footprint +
// height) so the building always stands its full height above the ground on every
// side and never gets buried by the slope. We sample not just the ring corners but
// a grid across the whole footprint (plus a small margin), because most OSM
// buildings are simple rectangles whose highest ground sits along an edge or in the
// interior — not at a corner.
// vertexH[i] = terrain elevation at ring vertex i — used for wall bottoms so each
// wall face starts at ground level, trimming the building to the terrain.
function bldgTerrainInfo(ring, height) {
  const vertexH = [];
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of ring) {
    const h = terrain ? terrain.sample(x, z) : 0;
    vertexH.push(h);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
  }

  let maxH = -Infinity;
  for (const h of vertexH) if (h > maxH) maxH = h;

  if (terrain) {
    const M = 3; // metres of margin so the roof also clears ground right at the walls
    const x0 = minX - M, x1 = maxX + M, z0 = minZ - M, z1 = maxZ + M;
    const nx = Math.min(8, Math.max(1, Math.round((x1 - x0) / 6)));
    const nz = Math.min(8, Math.max(1, Math.round((z1 - z0) / 6)));
    for (let i = 0; i <= nx; i++) {
      for (let j = 0; j <= nz; j++) {
        const h = terrain.sample(x0 + (x1 - x0) * i / nx, z0 + (z1 - z0) * j / nz);
        if (h > maxH) maxH = h;
      }
    }
  }

  if (!isFinite(maxH)) maxH = 0;
  return { topY: maxH + height, vertexH };
}

// ─── Overpass ────────────────────────────────────────────────────────────────

const OVERPASS_ENDPOINTS = [
  'https://overpass.kumi.systems/api/interpreter',   // fast, generous limits
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
let _opIdx = 0;

async function fetchOSMBbox(bbox) {
  const { south, west, north, east } = bbox;
  const query = [
    '[out:json][timeout:25];(',
    `way["building"](${south},${west},${north},${east});`,
    `way["highway"](${south},${west},${north},${east});`,
    `way["railway"](${south},${west},${north},${east});`,
    // Named POIs (points) for the F1 label overlay — only those with a name tag
    // so the payload stays small.
    `node["shop"]["name"](${south},${west},${north},${east});`,
    `node["amenity"]["name"](${south},${west},${north},${east});`,
    `node["tourism"]["name"](${south},${west},${north},${east});`,
    `node["office"]["name"](${south},${west},${north},${east});`,
    ');out body;>;out skel qt;',
  ].join('');
  // Round-robin across mirrors: one public endpoint only gives ~2 slots/IP and
  // rate-limits (429) or times out (504) under load, which was the real cause of
  // tiles crawling. Spreading across mirrors roughly triples our headroom and
  // routes around whichever server is slow right now.
  const url = OVERPASS_ENDPOINTS[_opIdx++ % OVERPASS_ENDPOINTS.length];
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
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
    const name = el.tags['name:en'] || el.tags.name || null;
    out.push({ id: el.id, ring, height: extractHeight(el.tags), name });
  }
  return out;
}

// Named point POIs (shops, restaurants, offices, attractions) for the label overlay.
const POI_KINDS = ['shop', 'amenity', 'tourism', 'office'];
function parsePOIs(osm) {
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'node' || !el.tags) continue;
    if (!POI_KINDS.some(k => el.tags[k])) continue;
    const name = el.tags['name:en'] || el.tags.name;
    if (!name) continue;
    const [x, z] = project(el.lat, el.lon);
    out.push({ id: 'n' + el.id, x, z, name });  // 'n' prefix: node ids share no space with way ids
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
  if (FOOT_TYPES.has(type)) return new THREE.Color(0xc0c0c0);  // light grey — footpaths/sidewalks
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

// ─── Labels (building names + POIs) ───────────────────────────────────────────

const truncateLabel = s => (s.length > 28 ? s.slice(0, 27) + '…' : s);

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

// Billboarded text label rendered to a canvas texture. depthTest stays on so labels
// are correctly occluded by buildings in front of them.
function makeLabelSprite(text, kind) {
  const fontSize = 44, padX = 14, padY = 9;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `600 ${fontSize}px system-ui, sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  canvas.width  = Math.ceil(textW + padX * 2);
  canvas.height = Math.ceil(fontSize + padY * 2);
  ctx.font = font;                 // reset — resizing the canvas clears context state
  ctx.textBaseline = 'middle';
  roundRectPath(ctx, 0, 0, canvas.width, canvas.height, 14);
  ctx.fillStyle = kind === 'poi' ? 'rgba(40,70,140,0.85)' : 'rgba(20,24,40,0.80)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(text, padX, canvas.height / 2 + 1);

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter  = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  const worldH = kind === 'poi' ? 4 : 5.5;
  spr.scale.set(worldH * canvas.width / canvas.height, worldH, 1);
  spr.renderOrder = 5;
  return spr;
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
  uniform float uXray;
  void main() {
    vec3  L     = normalize(vec3(0.5, 1.0, 0.3));
    float diff  = max(dot(normalize(vNorm), L), 0.0);
    float light = 0.60 + 0.40 * diff;
    float fade  = 1.0 - smoothstep(uNear, uFar, vDist);
    float a     = mix(1.0, 0.80, uXray) * fade;
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
  uniform float uXray;
  void main() {
    float fade = 1.0 - smoothstep(uNear, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, mix(1.0, 0.5, uXray) * fade);
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
  // uXray: 0 = solid (default), 1 = translucent x-ray (right-click held)
  return { uNear: { value: FADE_NEAR }, uFar: { value: FADE_FAR }, uXray: { value: 0.0 } };
}

function createMaterials() {
  return {
    // depthWrite/depthTest default to SOLID mode; setXray() flips them.
    surface: new THREE.ShaderMaterial({
      vertexShader: SURF_VERT, fragmentShader: SURF_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: true,
      side: THREE.DoubleSide,
    }),
    wireframe: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: WIRE_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
    }),
    // Streets/footpaths/rails are flat decals: they never write depth (so they
    // can't z-fight each other or the ground) and use a negative polygonOffset to
    // win the depth test against the terrain mesh they sit on. Road-over-footpath
    // ordering comes from renderOrder, not depth.
    street: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: STREET_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8,
      stencilWrite: true, stencilRef: 2,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    }),
    footpath: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: STREET_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
      stencilWrite: true, stencilRef: 1,
      stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.KeepStencilOp, stencilZFail: THREE.KeepStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    }),
    rail: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: STREET_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    }),
    metro: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: METRO_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
      depthTest: true, side: THREE.DoubleSide,
    }),
  };
}

// Switch all shared materials between SOLID (default) and X-RAY (right-click) modes.
function setMaterialsXray(mats, ground, on) {
  const x = on ? 1.0 : 0.0;
  for (const key of ['surface', 'street', 'footpath', 'rail']) {
    if (mats[key].uniforms.uXray) mats[key].uniforms.uXray.value = x;
  }
  // Solid: buildings + ground write depth so they occlude properly.
  // X-ray: drop those depth writes so everything shows through.
  // (street/footpath/rail never write depth in either mode — they're decals.)
  mats.surface.depthWrite = !on;
  if (ground) ground.material.depthWrite = !on;
  // Metro tunnels: solid hides them underground (depthTest on); x-ray shows them through the ground.
  mats.metro.depthTest = !on;
}

// ─── Geometry builders ───────────────────────────────────────────────────────

// topY: flat roof elevation. vertexH[i]: terrain height at ring[i], used as wall base.
function buildSingleBuildingGeo(ring, topY, vertexH) {
  const pos = [], norm = [], idx = [];
  let v = 0;
  const n = ring.length;
  const flat = ring.flatMap(([x, z]) => [x, z]);
  const tris = earcut(flat);
  if (!tris.length) return null;

  const rb = v;
  for (const [x, z] of ring) { pos.push(x, topY, z); norm.push(0, 1, 0); v++; }
  for (const i of tris) idx.push(rb + i);

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, z0] = ring[i], [x1, z1] = ring[j];
    // Extend wall bottoms below the sunk ground so no gap shows at the base.
    const h0 = vertexH[i] - (GROUND_SINK + 0.5), h1 = vertexH[j] - (GROUND_SINK + 0.5);
    const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
    const b = v;
    pos.push(x0, h0, z0,  x1, h1, z1,  x1, topY, z1,  x0, topY, z0);
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

    const { topY, vertexH } = bldgTerrainInfo(ring, height);

    const rb = v;
    for (const [x, z] of ring) {
      pos.push(x, topY, z); norm.push(0, 1, 0); col.push(rc.r, rc.g, rc.b); v++;
    }
    for (const i of tris) idx.push(rb + i);

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [x0, z0] = ring[i], [x1, z1] = ring[j];
      // Extend wall bottoms below the sunk ground so no gap shows at the base.
    const h0 = vertexH[i] - (GROUND_SINK + 0.5), h1 = vertexH[j] - (GROUND_SINK + 0.5);
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
      const b = v;
      pos.push(x0, h0, z0,  x1, h1, z1,  x1, topY, z1,  x0, topY, z0);
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
    const { topY, vertexH } = bldgTerrainInfo(ring, height);
    const base = buildSingleBuildingGeo(ring, topY, vertexH);
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

// Insert intermediate points so no segment is longer than maxLen, letting the
// ribbon follow terrain bumps instead of chording straight across them.
function densifyCoords(coords, maxLen) {
  const out = [coords[0]];
  for (let i = 1; i < coords.length; i++) {
    const [x0, z0] = coords[i - 1], [x1, z1] = coords[i];
    const d = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.ceil(d / maxLen);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      out.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
    }
  }
  return out;
}

// Builds a ribbon with miter joints so adjacent segments share exact corner vertices,
// eliminating the overlapping-rectangle artifact at road bends. yOff lifts the ribbon
// above the terrain so it layers cleanly over the ground.
function addRibbonToBuffers(rawCoords, halfW, pos, col, color, yOff) {
  const coords = terrain ? densifyCoords(rawCoords, 10) : rawCoords;
  const n = coords.length;
  if (n < 2) return;

  // Compute left/right edge vertices with miter joints at each node.
  const lx = [], lz = [], rx = [], rz = [];

  for (let i = 0; i < n; i++) {
    const [cx, cz] = coords[i];
    let mx, mz, scale = halfW;

    if (i === 0) {
      const dx = coords[1][0] - cx, dz = coords[1][1] - cz;
      const len = Math.hypot(dx, dz) || 1;
      mx = -dz / len; mz = dx / len;
    } else if (i === n - 1) {
      const dx = cx - coords[i-1][0], dz = cz - coords[i-1][1];
      const len = Math.hypot(dx, dz) || 1;
      mx = -dz / len; mz = dx / len;
    } else {
      const d1x = cx - coords[i-1][0], d1z = cz - coords[i-1][1];
      const d2x = coords[i+1][0] - cx, d2z = coords[i+1][1] - cz;
      const l1 = Math.hypot(d1x, d1z) || 1, l2 = Math.hypot(d2x, d2z) || 1;
      const n1x = -d1z / l1, n1z = d1x / l1;
      const n2x = -d2z / l2, n2z = d2x / l2;
      let bx = n1x + n2x, bz = n1z + n2z;
      const bl = Math.hypot(bx, bz);
      if (bl < 0.001) { mx = n1x; mz = n1z; }
      else {
        bx /= bl; bz /= bl;
        const dot = bx * n1x + bz * n1z;
        // dot approaches 0 at U-turns — clamp miter to 4× half-width
        scale = dot > 0.25 ? halfW / dot : halfW * 4;
        mx = bx; mz = bz;
      }
    }

    lx.push(cx - mx * scale); lz.push(cz - mz * scale);
    rx.push(cx + mx * scale); rz.push(cz + mz * scale);
  }

  // Emit quads as two triangles per segment strip.
  for (let i = 0; i < n - 1; i++) {
    const y0 = (terrain ? terrain.sample(coords[i][0],   coords[i][1])   : 0) + yOff;
    const y1 = (terrain ? terrain.sample(coords[i+1][0], coords[i+1][1]) : 0) + yOff;
    pos.push(
      lx[i],   y0, lz[i],
      rx[i],   y0, rz[i],
      lx[i+1], y1, lz[i+1],
      rx[i],   y0, rz[i],
      rx[i+1], y1, rz[i+1],
      lx[i+1], y1, lz[i+1],
    );
    for (let v = 0; v < 6; v++) col.push(color.r, color.g, color.b);
  }
}

function buildStreetLines(streets, roadMat, pathMat) {
  const rPos = [], rCol = [];
  const fPos = [], fCol = [];

  // Layer heights: footpaths just above ground, roads above footpaths.
  for (const { coords, highway } of streets) {
    const c    = streetColor(highway);
    const foot = FOOT_TYPES.has(highway);
    addRibbonToBuffers(coords, foot ? 1.5 : 3.5,
      foot ? fPos : rPos, foot ? fCol : rCol, c, foot ? 0.10 : 0.20);
  }

  const result = [];
  function make(pos, col, mat, ro) {
    if (!pos.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = ro;
    result.push(mesh);
  }
  make(fPos, fCol, pathMat, 1);
  make(rPos, rCol, roadMat, 3);
  return result;
}

function buildRailLines(rails, yLevel, mat) {
  const pos = [], col = [];
  for (const { coords, type } of rails) {
    const c = railColor(type);
    for (let i = 0; i < coords.length - 1; i++) {
      const [x0, z0] = coords[i], [x1, z1] = coords[i + 1];
      const ty0 = (terrain ? terrain.sample(x0, z0) : 0) + yLevel;
      const ty1 = (terrain ? terrain.sample(x1, z1) : 0) + yLevel;
      pos.push(x0, ty0, z0,  x1, ty1, z1);
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
    this.settled      = new Set(); // tile keys that reached a terminal state (done or gave up)
    this.metroCurves  = [];   // CatmullRomCurve3 paths collected as tiles load
    this.labelGroup   = new THREE.Group();   // name/POI labels — toggled with F1
    this.labelGroup.visible = false;         // off by default
    scene.add(this.labelGroup);
  }

  key(tx, ty) { return `${tx}_${ty}`; }

  request(tx, ty) {
    const k = this.key(tx, ty);
    if (this.tiles.has(k)) return;
    this.tiles.set(k, 'queued');
    this.queue.push({ tx, ty, k });
  }

  // Queue every tile within `radius` of the camera, nearest ring first so the
  // closest tiles always load before farther ones.
  requestAround(camX, camZ, radius) {
    const { lat, lon } = worldToGeo(camX, camZ);
    const { tx, ty }   = latLonToTile(lat, lon);
    for (let r = 0; r <= radius; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++)
          if (Math.max(Math.abs(dx), Math.abs(dy)) === r) this.request(tx + dx, ty + dy);
  }

  update(camX, camZ) {
    this.requestAround(camX, camZ, LOAD_RADIUS);
    if (!this.busy && this.queue.length) this._process();
  }

  async _process() {
    if (this.busy) return;
    this.busy = true;

    // Two workers pull from the shared queue — fast enough to load the whole radius
    // grid quickly while staying within Overpass's per-IP concurrency limit.
    const worker = async () => {
      while (this.queue.length) {
        const { tx, ty, k } = this.queue.shift();
        this.tiles.set(k, 'loading');
        await this._loadTile(tx, ty, k);
        if (this.queue.length) await sleep(150);
      }
    };
    await Promise.all([worker(), worker()]);

    this.busy = false;
    // A retry scheduled while we were draining may have queued work after the
    // workers exited but before busy flipped — pick it up so nothing strands.
    if (this.queue.length) this._process();
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
      const pois  = parsePOIs(osm)
        .filter(p => { if (this.seenIds.has(p.id)) return false; this.seenIds.add(p.id); return true; });

      // Register footprints for collision; add a name label above named buildings.
      for (const { ring, height, name } of bldgs) {
        const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
        const { topY: bTop } = bldgTerrainInfo(ring, height);
        this.footprints.push({
          ring, height,
          topY: bTop,
          minX: Math.min(...xs), maxX: Math.max(...xs),
          minZ: Math.min(...zs), maxZ: Math.max(...zs),
        });
        if (name) {
          let cx = 0, cz = 0;
          for (const [x, z] of ring) { cx += x; cz += z; }
          const spr = makeLabelSprite(truncateLabel(name), 'bldg');
          spr.position.set(cx / ring.length, bTop + 3, cz / ring.length);
          this.labelGroup.add(spr);
        }
      }

      // POI labels (points) at head height above the ground.
      for (const p of pois) {
        const spr = makeLabelSprite(truncateLabel(p.name), 'poi');
        const y = (terrain ? terrain.sample(p.x, p.z) : 0) + 4;
        spr.position.set(p.x, y, p.z);
        this.labelGroup.add(spr);
      }

      const group = new THREE.Group();
      if (bldgs.length) {
        group.add(buildSurfaceMesh(bldgs, this.mats.surface));
        group.add(buildEdgesGeoMesh(bldgs, this.mats.wireframe));
        this.buildings += bldgs.length;
      }
      if (strs.length) {
        for (const m of buildStreetLines(strs, this.mats.street, this.mats.footpath)) group.add(m);
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
        // Surface-rail trains ride 1.9 m above the terrain so they stay visible
        // on hills and in valleys (a fixed y would bury them once terrain tilts).
        for (const { coords } of surface) {
          if (coords.length < 2) continue;
          const pts = [];
          for (const [x, z] of coords) {
            const y = (terrain ? terrain.sample(x, z) : 0) + 1.9;
            const v = new THREE.Vector3(x, y, z);
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
      // Retry up to 6× with short back-off — each retry hits a different mirror,
      // so a quick retry usually lands on a server that isn't rate-limiting us.
      const attempt = this._retries.get(k) || 0;
      if (attempt < 6) {
        this._retries.set(k, attempt + 1);
        const delay = [800, 1500, 3000, 5000, 8000, 8000][attempt];
        setTimeout(() => {
          this.tiles.delete(k);
          this.request(tx, ty);
          if (!this.busy) this._process();
        }, delay);
        return; // don't count as done yet — retry is in flight
      }
    }
    this.tilesLoaded++;
    this.settled.add(k); // done, or gave up after exhausting retries
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

  // Returns the standing floor Y under (x, z): terrain height outside buildings,
  // building-top height inside buildings.
  getFloorHeight(x, z) {
    const groundY = terrain ? terrain.sample(x, z) : 0;
    let maxH = groundY;
    for (const fp of this.footprints) {
      if (x < fp.minX || x > fp.maxX || z < fp.minZ || z > fp.maxZ) continue;
      if (!pointInPolygon(x, z, fp.ring)) continue;
      if (fp.topY > maxH) maxH = fp.topY;
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
  const typingInField = e => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  window.addEventListener('keydown', e => {
    if (typingInField(e)) return;            // don't capture keys while typing in the search box
    keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

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
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, stencil: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x000000, 0); // transparent — sky comes from CSS gradient
  document.body.appendChild(renderer.domElement);

  const scene  = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(90, innerWidth / innerHeight, 0.15, 2000);
  camera.position.set(0, 1.6, 0);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000, 256, 256),
    new THREE.ShaderMaterial({
      uniforms: {
        uGround: { value: new THREE.Color(0xd8dce8) },
        uFar:    { value: FADE_FAR },
      },
      transparent: true,
      depthWrite: true,   // solid default: ground occludes underground tunnels/trains
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

  const trainRef  = { system: null };
  const labelsRef = { group: null };   // set once tiles load; toggled by F1
  const LABEL_DIST = 250;               // only show labels within this many metres
  let lastTime = performance.now();

  (function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.1);
    lastTime  = now;
    controls.update();
    if (trainRef.system) trainRef.system.update(dt);
    // Declutter: only keep labels near the camera visible.
    if (labelsRef.group && labelsRef.group.visible) {
      const cp = camera.position;
      for (const s of labelsRef.group.children) s.visible = cp.distanceTo(s.position) < LABEL_DIST;
    }
    renderer.render(scene, camera);
  })();

  return { scene, camera, controls, trainRef, labelsRef, ground };
}

// ─── Geocoding (OpenStreetMap Nominatim — no API key) ─────────────────────────

async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q='
            + encodeURIComponent(query);
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data) || !data.length) return null;
  return {
    lat:   parseFloat(data[0].lat),
    lon:   parseFloat(data[0].lon),
    label: data[0].display_name || query,
  };
}

// Approximate current location from IP address (no permission prompt). Falls back
// across two free, key-less, CORS-enabled services.
async function ipLocate() {
  try {
    const r = await fetch('https://ipapi.co/json/');
    if (r.ok) {
      const d = await r.json();
      if (d.latitude && d.longitude)
        return { lat: +d.latitude, lon: +d.longitude, label: d.city || 'My location' };
    }
  } catch (_) { /* try fallback */ }
  const r = await fetch('https://ipwho.is/');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const d = await r.json();
  if (!d.success || !d.latitude || !d.longitude) throw new Error('no location');
  return { lat: +d.latitude, lon: +d.longitude, label: d.city || 'My location' };
}

// Shows the search field on the loading screen and resolves once the user picks a
// place that geocodes successfully. Returns { lat, lon, label, shortLabel }.
function promptLocation() {
  return new Promise(resolve => {
    const input = document.getElementById('place-input');
    const btn   = document.getElementById('place-go');
    const meBtn = document.getElementById('place-me');
    const msg   = document.getElementById('search-msg');
    input.focus();
    input.select();

    const lock   = () => { btn.disabled = input.disabled = meBtn.disabled = true; };
    const unlock = () => { btn.disabled = input.disabled = meBtn.disabled = false; };

    async function go() {
      const q = input.value.trim();
      if (!q) return;
      lock();
      msg.textContent = 'Searching…';
      try {
        const hit = await geocode(q);
        if (!hit) {
          msg.textContent = `Couldn't find “${q}”. Try another place.`;
          unlock(); input.focus(); input.select();
          return;
        }
        hit.shortLabel = (hit.label.split(',')[0] || q).trim();
        resolve(hit);
      } catch (err) {
        msg.textContent = 'Search failed — check your connection and retry.';
        unlock();
      }
    }

    async function useMyLocation() {
      lock();
      msg.textContent = 'Locating you…';
      try {
        const hit = await ipLocate();
        hit.shortLabel = (hit.label.split(',')[0] || 'My location').trim();
        resolve(hit);
      } catch (err) {
        msg.textContent = "Couldn't detect your location — enter a place instead.";
        unlock();
      }
    }

    btn.addEventListener('click', go);
    meBtn.addEventListener('click', useMyLocation);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}

function setPlaceLabel(name) {
  document.title = `${name} · 3D`;
  const lt = document.getElementById('load-title');
  const h1 = document.querySelector('#overlay h1');
  if (lt) lt.textContent = name;
  if (h1) h1.textContent = name;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const loadMsg  = document.getElementById('load-msg');
  const statusEl = document.getElementById('status');

  // Mutable ref so controls (created first) can call collision once tiles arrive
  const collision = { fn: null };
  const { scene, camera, controls, trainRef, labelsRef, ground } = initScene(collision);

  // Ask where to start, geocode it, then center the world there.
  const place = await promptLocation();
  setCenter(place.lat, place.lon);
  setPlaceLabel(place.shortLabel);

  // Switch the loading screen from search mode to progress mode.
  document.getElementById('load-search').style.display = 'none';
  document.getElementById('place-me').style.display    = 'none';
  document.getElementById('search-msg').style.display  = 'none';
  document.getElementById('pbar-bg').style.display = '';

  // Load terrain elevation tiles before OSM tiles so geometry is placed correctly.
  loadMsg.textContent = 'Loading terrain…';
  terrain = await loadTerrain();
  if (terrain) {
    // Displace ground plane vertices. PlaneGeometry is in XY before rotation.x = -π/2,
    // which maps local (x, y, z) → world (x, z, -y). To set world Y, set local Z.
    const pos = ground.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, terrain.sample(pos.getX(i), -pos.getY(i)) - GROUND_SINK);
    }
    pos.needsUpdate = true;
    ground.geometry.computeVertexNormals();
    camera.position.y = terrain.sample(0, 0) + EYE_HEIGHT;
  }

  loadMsg.textContent = `Fetching ${place.shortLabel} from OpenStreetMap…`;

  const mats    = createMaterials();
  const manager = new TileManager(scene, mats, statusEl);

  // Wire collision after manager exists
  collision.fn      = (x, z, y, R) => manager.isInBuilding(x, z, y, R);
  collision.floorFn = (x, z)    => manager.getFloorHeight(x, z);

  // F1 toggles the name/POI label overlay (off by default).
  labelsRef.group = manager.labelGroup;
  window.addEventListener('keydown', e => {
    if (e.code === 'F1') {
      e.preventDefault();
      manager.labelGroup.visible = !manager.labelGroup.visible;
    }
  });

  // X-ray view: solid by default; translucent only while right mouse button is held.
  function setXray(on) {
    setMaterialsXray(mats, ground, on);
    if (trainRef.system) trainRef.system.setXray(on);
  }
  window.addEventListener('mousedown', e => { if (e.button === 2) setXray(true);  });
  window.addEventListener('mouseup',   e => { if (e.button === 2) setXray(false); });
  window.addEventListener('contextmenu', e => e.preventDefault());
  // Reset on blur so a button released off-window doesn't leave us stuck in x-ray.
  window.addEventListener('blur', () => setXray(false));

  // Queue the 3×3 core first and wait only for it — that's all the player can see
  // at spawn. The rest of the radius streams in afterwards (queued behind the core,
  // nearest-first), so we start fast without spawning next to an unloaded hole.
  manager.requestAround(0, 0, 1);
  const coreKeys = manager.queue.map(t => t.k);
  manager.requestAround(0, 0, LOAD_RADIUS);   // append the outer ring (dedup skips the core)
  manager.tilesTotal = coreKeys.length;
  if (!manager.busy) manager._process();

  let lastCheck = 0;
  controls.addEventListener('change', () => {
    const now = Date.now();
    if (now - lastCheck > 1000) {
      lastCheck = now;
      manager.update(camera.position.x, camera.position.z);
    }
  });

  // Rebuild trains from all track loaded so far. Called once the core is ready and
  // again after the background ring finishes, so streamed-in tracks get trains too.
  // (stitch makes fresh curve objects each time, so we replace the system wholesale
  // rather than appending, which would duplicate trains.)
  let trainCurveCount = -1;
  function syncTrains() {
    if (manager.metroCurves.length === trainCurveCount) return;
    trainCurveCount = manager.metroCurves.length;
    const cleaned = stitchMetroCurves(manager.metroCurves).flatMap(splitAtSharpTurns);
    if (trainRef.system) for (const t of trainRef.system.trains) t.dispose(scene);
    trainRef.system = new TrainSystem(scene, cleaned);
  }

  const pbar    = document.getElementById('pbar');
  const loadMsg2 = document.getElementById('load-msg');
  const loading = document.getElementById('loading');
  let shown = false;
  const poll = setInterval(() => {
    if (shown) return;
    const done  = coreKeys.reduce((n, k) => n + (manager.settled.has(k) ? 1 : 0), 0);
    const total = coreKeys.length;
    pbar.style.width = `${(done / total) * 100}%`;
    loadMsg2.textContent = `Loading map… ${done} / ${total} tiles`;

    if (done >= total) {
      // Core grid loaded — reveal the scene; outer tiles keep loading in the background.
      shown = true;
      clearInterval(poll);
      loading.classList.add('fade-out');
      setTimeout(() => loading.remove(), 800);
      syncTrains();
      // Once the full radius has streamed in, rebuild trains so new track is covered.
      const ringPoll = setInterval(() => {
        if (!manager.busy && manager.queue.length === 0) {
          clearInterval(ringPoll);
          syncTrains();
        }
      }, 2000);
    }
  }, 200);
}

main();
