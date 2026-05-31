import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import earcut from 'earcut';
import { TrainSystem } from './train.js?v=11.48';
import { FISH_U, fishUniforms, FISH_PROJ_GLSL, FISH_FRAG_GLSL, TOON_GLSL } from './fisheye.js?v=11.48';

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
const METRO_DEPTH   = -7;
const EYE_HEIGHT    = 1.6;
// Sink the ground mesh this far below true terrain so its coarse triangles can
// never poke up through the thin road/footpath decals laid just above terrain.
const GROUND_SINK   = 0.6;
// Bird (third-person) constants
const BIRD_HEIGHT   = 3.96;   // 13 ft above terrain
const BIRD_CAM_BACK = 8;      // metres behind bird
const BIRD_CAM_UP   = 2;      // metres above bird
// Fisheye (F3) constants — single-pass vertex-warp fisheye (1 render, not 6).
// FISH_FOV_DEG + the projection live in fisheye.js (shared with train.js).
const FISH_CAM_BACK = 4.0;    // follow distance in fisheye mode
const FISH_CAM_UP   = 0.45;   // hug close to the bird's level
// Max edge length (metres) for geometry tessellation, so long straight lines
// curve smoothly once the fisheye warp bends them.
const WALL_SEG      = 9;      // building wall grid cell
const EDGE_SEG      = 7;      // wireframe outline segment
const DECAL_SEG     = 8;      // water/road area max triangle edge (fisheye subdivision)

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

// ─── Overpass response cache (IndexedDB, 3-day TTL) ───────────────────────────

const CACHE_DB = 'tokyo3d', CACHE_STORE = 'overpass';
const CACHE_TTL = 3 * 24 * 60 * 60 * 1000;   // 3 days
const QUERY_VERSION = 'v2';                  // bump to invalidate cache when the query changes

let _dbPromise = null;
function openCache() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(CACHE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(CACHE_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }).catch(() => null);   // private mode / blocked → run without a cache
  return _dbPromise;
}

async function cacheGet(key) {
  const db = await openCache();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const r = db.transaction(CACHE_STORE, 'readonly').objectStore(CACHE_STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror   = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(key, value) {
  const db = await openCache();
  if (!db) return;
  try {
    db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE).put(value, key);
  } catch { /* ignore */ }
}

// Drop expired entries once at startup so storage doesn't grow unbounded.
async function pruneCache() {
  const db = await openCache();
  if (!db) return;
  try {
    const cur = db.transaction(CACHE_STORE, 'readwrite').objectStore(CACHE_STORE).openCursor();
    cur.onsuccess = e => {
      const c = e.target.result;
      if (!c) return;
      if (!c.value || Date.now() - c.value.ts > CACHE_TTL) c.delete();
      c.continue();
    };
  } catch { /* ignore */ }
}

// ─── Overpass ────────────────────────────────────────────────────────────────

// Known to send permissive CORS headers from the browser. de is the reliable
// primary; kumi is a fast fallback used on retries.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
let _opIdx = 0;

async function fetchOSMBbox(bbox) {
  const { south, west, north, east } = bbox;
  const cacheKey = `${QUERY_VERSION}:${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
  const cached = await cacheGet(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const query = [
    '[out:json][timeout:25];(',
    `way["building"](${south},${west},${north},${east});`,
    `way["highway"](${south},${west},${north},${east});`,
    `way["railway"](${south},${west},${north},${east});`,
    `way["natural"="water"](${south},${west},${north},${east});`,
    `way["waterway"](${south},${west},${north},${east});`,
    `way["landuse"="reservoir"](${south},${west},${north},${east});`,
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
    cachePut(cacheKey, { ts: Date.now(), data });   // fire-and-forget; 3-day TTL
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Separate lightweight query for named POIs only — fired in the background after
// the scene reveals so it doesn't slow down first load. Uses its own cache key.
async function fetchOSMPOIs(bbox) {
  const { south, west, north, east } = bbox;
  const cacheKey = `poi_${QUERY_VERSION}:${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
  const cached = await cacheGet(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.data;

  const query = [
    '[out:json][timeout:25];(',
    `node["shop"]["name"](${south},${west},${north},${east});`,
    `node["amenity"]["name"](${south},${west},${north},${east});`,
    `node["tourism"]["name"](${south},${west},${north},${east});`,
    `node["office"]["name"](${south},${west},${north},${east});`,
    ');out body;',
  ].join('');
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
    if (data.remark && /error|timeout/i.test(data.remark))
      throw new Error(`Overpass: ${data.remark}`);
    if (!Array.isArray(data.elements))
      throw new Error('Overpass: malformed response (no elements array)');
    cachePut(cacheKey, { ts: Date.now(), data });
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

const WATERWAY_RENDER = new Set(['river','canal','stream','drain']);

function parseWaterAreas(osm, nodeMap) {
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'way') continue;
    const t = el.tags;
    if (!t) continue;
    if (t.natural !== 'water' && t.landuse !== 'reservoir' && t.waterway !== 'riverbank') continue;
    const ring = el.nodes.map(id => nodeMap.get(id)).filter(Boolean);
    if (ring.length > 1) {
      const [ax, az] = ring[0], [bx, bz] = ring[ring.length - 1];
      if (ax === bx && az === bz) ring.pop();
    }
    if (ring.length < 3) continue;
    out.push({ id: el.id, ring });
  }
  return out;
}

function parseWaterways(osm, nodeMap) {
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags?.waterway) continue;
    if (!WATERWAY_RENDER.has(el.tags.waterway)) continue;
    if (el.tags.area === 'yes') continue;   // rendered as polygon by parseWaterAreas
    const coords = el.nodes.map(id => nodeMap.get(id)).filter(Boolean);
    if (coords.length < 2) continue;
    out.push({ id: el.id, coords, type: el.tags.waterway });
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

// Render label text to a canvas. `bg` draws a rounded pill behind it (for floating
// POI labels); `stroke` outlines the glyphs so signage reads on any wall colour.
function renderLabelCanvas(text, { bg, stroke, fg = '#fff', fontSize = 48 }) {
  const padX = Math.round(fontSize / 3), padY = Math.round(fontSize / 4);
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const font = `700 ${fontSize}px system-ui, sans-serif`;
  ctx.font = font;
  const textW = ctx.measureText(text).width;
  canvas.width  = Math.ceil(textW + padX * 2);
  canvas.height = Math.ceil(fontSize + padY * 2);
  ctx.font = font;                 // reset — resizing the canvas clears context state
  ctx.textBaseline = 'middle';
  if (bg) { roundRectPath(ctx, 0, 0, canvas.width, canvas.height, Math.round(fontSize * 0.29)); ctx.fillStyle = bg; ctx.fill(); }
  const tx = padX, ty = canvas.height / 2 + 1;
  if (stroke) { ctx.lineWidth = Math.round(fontSize * 0.15) || 1; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke; ctx.strokeText(text, tx, ty); }
  ctx.fillStyle = fg;
  ctx.fillText(text, tx, ty);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter  = THREE.LinearFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  return { tex, aspect: canvas.width / canvas.height };
}

// A textured plane laid flat against a wall at (x,z), facing outward along (nx,nz),
// centred at height y. Sits just proud of the wall to avoid z-fighting.
function wallPlaneMesh(tex, w, h, x, z, nx, nz, y) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  const off = 0.4;
  mesh.position.set(x + nx * off, y, z + nz * off);
  mesh.lookAt(mesh.position.x + nx, mesh.position.y, mesh.position.z + nz);  // face outward, upright
  mesh.renderOrder = 5;
  return mesh;
}

// Outward-facing horizontal normal of a ring edge at point (qx,qz), pointing away
// from the footprint centroid.
function outwardNormal(ring, ex, ez, qx, qz) {
  const len = Math.hypot(ex, ez) || 1;
  let nx = -ez / len, nz = ex / len;
  let cx = 0, cz = 0;
  for (const [x, z] of ring) { cx += x; cz += z; }
  cx /= ring.length; cz /= ring.length;
  if ((qx + nx - cx) ** 2 + (qz + nz - cz) ** 2 < (qx - cx) ** 2 + (qz - cz) ** 2) { nx = -nx; nz = -nz; }
  return { nx, nz };
}

// A name laid flat onto the building's longest wall so it reads as signage on the
// facade rather than a floating tag.
function makeBuildingLabel(ring, topY, text) {
  // Longest footprint edge = most prominent facade.
  let bi = 0, best = -1;
  for (let i = 0; i < ring.length; i++) {
    const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len > best) { best = len; bi = i; }
  }
  if (best < 5) return null;   // too small a wall to carry a readable sign

  const [x0, z0] = ring[bi], [x1, z1] = ring[(bi + 1) % ring.length];
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const { nx, nz } = outwardNormal(ring, x1 - x0, z1 - z0, mx, mz);

  const base    = terrain ? terrain.sample(mx, mz) : 0;
  const facadeH = Math.max(topY - base, 3);

  const { tex, aspect } = renderLabelCanvas(text, { stroke: 'rgba(0,0,0,0.6)' });
  let h = Math.min(facadeH * 0.28, 10);
  let w = h * aspect;
  if (w > best * 0.9) { const f = best * 0.9 / w; w *= f; h *= f; }   // fit within the wall
  const cy = Math.max(base + h / 2 + 0.5, base + Math.min(facadeH * 0.62, facadeH - h / 2 - 0.5));
  return wallPlaneMesh(tex, w, h, mx, mz, nx, nz, cy);
}

// Find the closest building wall to a point, within maxDist metres. Returns the
// footprint, the projection of the point onto that wall, and the edge direction.
function nearestWall(px, pz, footprints, maxDist) {
  let best = null, bestD2 = maxDist * maxDist;
  for (const fp of footprints) {
    if (px < fp.minX - maxDist || px > fp.maxX + maxDist ||
        pz < fp.minZ - maxDist || pz > fp.maxZ + maxDist) continue;
    const ring = fp.ring;
    for (let i = 0; i < ring.length; i++) {
      const [x0, z0] = ring[i], [x1, z1] = ring[(i + 1) % ring.length];
      const dx = x1 - x0, dz = z1 - z0;
      const l2 = dx * dx + dz * dz || 1e-6;
      const t = Math.max(0, Math.min(1, ((px - x0) * dx + (pz - z0) * dz) / l2));
      const qx = x0 + dx * t, qz = z0 + dz * t;
      const d2 = (px - qx) ** 2 + (pz - qz) ** 2;
      if (d2 < bestD2) { bestD2 = d2; best = { fp, qx, qz, ex: dx, ez: dz, len: Math.hypot(dx, dz) }; }
    }
  }
  return best;
}

// A POI sign laid flat on the nearest building wall (storefront height). Falls back
// to a floating billboard when the POI isn't near any building.
function makePoiLabel(px, pz, text, footprints) {
  const { tex, aspect } = renderLabelCanvas(text, { bg: 'rgba(40,70,140,0.88)', fontSize: 24 });
  const wall = nearestWall(px, pz, footprints, 25);
  if (wall) {
    const { nx, nz } = outwardNormal(wall.fp.ring, wall.ex, wall.ez, wall.qx, wall.qz);
    let h = 1.3, w = h * aspect;
    if (w > wall.len * 0.9) { const f = wall.len * 0.9 / w; w *= f; h *= f; }
    const y = (terrain ? terrain.sample(wall.qx, wall.qz) : 0) + 3.5;
    return wallPlaneMesh(tex, w, h, wall.qx, wall.qz, nx, nz, y);
  }
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  spr.scale.set(2 * aspect, 2, 1);
  spr.renderOrder = 5;
  const y = (terrain ? terrain.sample(px, pz) : 0) + 4;
  spr.position.set(px, y, pz);
  return spr;
}

// ─── Shaders ─────────────────────────────────────────────────────────────────

const SURF_VERT = /* glsl */`
  attribute vec3 color;
  varying vec3  vCol;
  varying float vDist;
  varying vec3  vNorm;
  ${FISH_PROJ_GLSL}
  void main() {
    vCol  = color;
    vNorm = normalMatrix * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    vFishView = mv.xyz;
    gl_Position = projectVertex(mv);
  }
`;

const SURF_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  varying vec3  vNorm;
  uniform float uNear;
  uniform float uFar;
  uniform float uXray;
  ${FISH_FRAG_GLSL}
  ${TOON_GLSL}
  void main() {
    fishClip();
    vec3  N      = normalize(vNorm);
    vec3  V      = normalize(-vFishView);
    vec3  L      = normalize(vec3(0.5, 1.0, 0.3));
    vec3  shaded = celShade(vCol, N, V, L);
    float fade   = 1.0 - smoothstep(uNear, uFar, vDist);
    float a      = mix(1.0, 0.80, uXray) * fade;
    if (a < 0.01) discard;
    gl_FragColor = vec4(shaded, a);
  }
`;

const LINE_VERT = /* glsl */`
  attribute vec3 color;
  varying vec3  vCol;
  varying float vDist;
  ${FISH_PROJ_GLSL}
  void main() {
    vCol = color;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist = length(mv.xyz);
    vFishView = mv.xyz;
    gl_Position = projectVertex(mv);
  }
`;

const WIRE_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  ${FISH_FRAG_GLSL}
  void main() {
    fishClip();
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
  ${FISH_FRAG_GLSL}
  void main() {
    fishClip();
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
  ${FISH_FRAG_GLSL}
  void main() {
    fishClip();
    float fade = 1.0 - smoothstep(uNear * 0.5, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.05 * fade);
  }
`;

const WATER_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  ${FISH_FRAG_GLSL}
  void main() {
    fishClip();
    float fade = 1.0 - smoothstep(uNear, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.80 * fade);
  }
`;

function fadeUniforms() {
  // uXray: 0 = solid (default), 1 = translucent x-ray (right-click held)
  return {
    uNear: { value: FADE_NEAR }, uFar: { value: FADE_FAR }, uXray: { value: 0.0 },
    ...fishUniforms(),
  };
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
    // Water sits just above terrain, below roads. depthWrite:false so it
    // doesn't occlude footpaths/roads drawn on its surface.
    water: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: WATER_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2,
      side: THREE.DoubleSide,
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

    // Tessellate each earcut roof triangle so fisheye has enough vertices to curve it
    for (let t = 0; t < tris.length; t += 3) {
      const i0 = tris[t], i1 = tris[t+1], i2 = tris[t+2];
      const x0 = ring[i0][0], z0 = ring[i0][1];
      const x1 = ring[i1][0], z1 = ring[i1][1];
      const x2 = ring[i2][0], z2 = ring[i2][1];
      const maxEdge = Math.max(Math.hypot(x1-x0,z1-z0), Math.hypot(x2-x1,z2-z1), Math.hypot(x0-x2,z0-z2));
      const N = Math.min(4, Math.max(1, Math.ceil(maxEdge / WALL_SEG)));
      const vbase = v;
      for (let j = 0; j <= N; j++) {
        const vv = j / N;
        for (let i = 0; i <= N - j; i++) {
          const u = i / N, w = 1 - u - vv;
          pos.push(x0*w + x1*u + x2*vv, topY, z0*w + z1*u + z2*vv);
          norm.push(0, 1, 0); col.push(rc.r, rc.g, rc.b); v++;
        }
      }
      for (let j = 0; j < N; j++) {
        const rs0 = j*(N+1) - j*(j-1)/2;
        const rs1 = (j+1)*(N+1) - (j+1)*j/2;
        for (let i = 0; i < N - j; i++) {
          const a = vbase+rs0+i, b = vbase+rs0+i+1, c = vbase+rs1+i;
          idx.push(a, b, c);
          if (i < N - j - 1) idx.push(b, vbase+rs1+i+1, c);
        }
      }
    }

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [x0, z0] = ring[i], [x1, z1] = ring[j];
      // Extend wall bottoms below the sunk ground so no gap shows at the base.
      const h0 = vertexH[i] - (GROUND_SINK + 0.5), h1 = vertexH[j] - (GROUND_SINK + 0.5);
      const dx = x1 - x0, dz = z1 - z0, len = Math.hypot(dx, dz) || 1;
      const nxx = dz / len, nzz = -dx / len;
      // Tessellate each wall into a grid so its silhouette curves under the
      // fisheye warp instead of staying a straight chord. Small walls stay 1×1.
      const cols = Math.min(6, Math.max(1, Math.ceil(len / WALL_SEG)));
      const tall = topY - Math.min(h0, h1);
      const rows = Math.min(8, Math.max(1, Math.ceil(tall / WALL_SEG)));
      const b = v;
      for (let cu = 0; cu <= cols; cu++) {
        const u = cu / cols;
        const wx = x0 + dx * u, wz = z0 + dz * u, base = h0 + (h1 - h0) * u;
        for (let rv = 0; rv <= rows; rv++) {
          const y = base + (topY - base) * (rv / rows);
          pos.push(wx, y, wz); norm.push(nxx, 0, nzz); col.push(wc.r, wc.g, wc.b); v++;
        }
      }
      const stride = rows + 1;
      for (let cu = 0; cu < cols; cu++) {
        for (let rv = 0; rv < rows; rv++) {
          const a = b + cu * stride + rv;
          const c = a + stride;
          idx.push(a, c, c + 1,  a, c + 1, a + 1);
        }
      }
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
    // Subdivide each outline segment so it curves smoothly under the fisheye warp.
    for (let i = 0; i + 1 < posAttr.count; i += 2) {
      const ax = posAttr.getX(i),   ay = posAttr.getY(i),   az = posAttr.getZ(i);
      const bx = posAttr.getX(i+1), by = posAttr.getY(i+1), bz = posAttr.getZ(i+1);
      const seg = Math.min(8, Math.max(1, Math.ceil(Math.hypot(bx-ax, by-ay, bz-az) / EDGE_SEG)));
      let px = ax, py = ay, pz = az;
      for (let s = 1; s <= seg; s++) {
        const t = s / seg;
        const qx = ax + (bx-ax)*t, qy = ay + (by-ay)*t, qz = az + (bz-az)*t;
        allPos.push(px, py, pz, qx, qy, qz);
        allCol.push(c.r, c.g, c.b, c.r, c.g, c.b);
        px = qx; py = qy; pz = qz;
      }
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
  const coords = terrain ? densifyCoords(rawCoords, DECAL_SEG) : rawCoords;
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

function waterwayHalfWidth(type) {
  switch (type) {
    case 'river':  return 12;
    case 'canal':  return 5;
    case 'stream': return 2;
    default:       return 1.5;
  }
}

// Emit a triangle (xz plane) into pos/col, recursively bisecting its longest
// edge until every edge is shorter than maxEdge. Big flat triangles look fine
// in plain perspective but the fisheye warp bends only their vertices, leaving
// straight chords that read as huge faceted smears when you fly low over them.
// Fine triangles let the per-vertex warp curve the surface smoothly. y is
// sampled from the terrain per emitted vertex so the fill hugs the ground.
function emitTriSubdivided(ax, az, bx, bz, cx, cz, maxEdge, pos, col, color, yOff, depth = 0) {
  const eAB = Math.hypot(bx - ax, bz - az);
  const eBC = Math.hypot(cx - bx, cz - bz);
  const eCA = Math.hypot(ax - cx, az - cz);
  const maxE = Math.max(eAB, eBC, eCA);
  if (depth >= 7 || maxE <= maxEdge) {
    const push = (x, z) => {
      pos.push(x, (terrain ? terrain.sample(x, z) : 0) + yOff, z);
      col.push(color.r, color.g, color.b);
    };
    push(ax, az); push(bx, bz); push(cx, cz);
    return;
  }
  // Bisect the longest edge — keeps sub-triangles well-shaped and terminates.
  if (eAB >= eBC && eAB >= eCA) {
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    emitTriSubdivided(ax, az, mx, mz, cx, cz, maxEdge, pos, col, color, yOff, depth + 1);
    emitTriSubdivided(mx, mz, bx, bz, cx, cz, maxEdge, pos, col, color, yOff, depth + 1);
  } else if (eBC >= eAB && eBC >= eCA) {
    const mx = (bx + cx) / 2, mz = (bz + cz) / 2;
    emitTriSubdivided(ax, az, bx, bz, mx, mz, maxEdge, pos, col, color, yOff, depth + 1);
    emitTriSubdivided(ax, az, mx, mz, cx, cz, maxEdge, pos, col, color, yOff, depth + 1);
  } else {
    const mx = (cx + ax) / 2, mz = (cz + az) / 2;
    emitTriSubdivided(ax, az, bx, bz, mx, mz, maxEdge, pos, col, color, yOff, depth + 1);
    emitTriSubdivided(mx, mz, bx, bz, cx, cz, maxEdge, pos, col, color, yOff, depth + 1);
  }
}

// Triangulated fill for water-area polygons (lakes, reservoirs, river banks).
function buildWaterAreaMesh(areas, mat) {
  const pos = [], col = [];
  const wc = new THREE.Color(0x4488bb);

  for (const { ring } of areas) {
    const flat = ring.flatMap(([x, z]) => [x, z]);
    const tris = earcut(flat);
    if (!tris.length) continue;
    // Subdivide each earcut triangle so the fisheye warp curves it smoothly
    // instead of smearing across the screen as a giant flat facet.
    for (let i = 0; i < tris.length; i += 3) {
      const [ax, az] = ring[tris[i]];
      const [bx, bz] = ring[tris[i + 1]];
      const [cx, cz] = ring[tris[i + 2]];
      emitTriSubdivided(ax, az, bx, bz, cx, cz, DECAL_SEG, pos, col, wc, 0.12);
    }
  }

  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 0;
  return mesh;
}

// Ribbon geometry for river/canal centre-lines (where no area polygon exists).
function buildWaterLines(waterways, mat) {
  const pos = [], col = [];
  const wc = new THREE.Color(0x4488bb);
  for (const { coords, type } of waterways) {
    addRibbonToBuffers(coords, waterwayHalfWidth(type), pos, col, wc, 0.12);
  }
  if (!pos.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 0;
  return mesh;
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
const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

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
    this.metroCurves        = [];   // CatmullRomCurve3 paths collected as tiles load
    this.buildingLabelGroup = new THREE.Group();   // building names — toggled with F1
    this.buildingLabelGroup.visible = false;
    scene.add(this.buildingLabelGroup);
    this.poiLabelGroup = new THREE.Group();        // POI labels — toggled with F2
    this.poiLabelGroup.visible = false;
    scene.add(this.poiLabelGroup);
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

  // Parse one Overpass response and build all geometry/labels from it. Shared by
  // per-tile and whole-region loads. Dedup via seenIds means overlapping fetches
  // (e.g. a region that re-covers already-loaded tiles) add nothing twice.
  _ingest(osm) {
    const nodeMap = buildNodeMap(osm);

    const bldgs = parseBuildings(osm, nodeMap)
      .filter(b => { if (this.seenIds.has(b.id)) return false; this.seenIds.add(b.id); return true; });
    const strs  = parseStreets(osm, nodeMap)
      .filter(s => { if (this.seenIds.has(s.id)) return false; this.seenIds.add(s.id); return true; });
    const rails = parseRailways(osm, nodeMap)
      .filter(r => { if (this.seenIds.has(r.id)) return false; this.seenIds.add(r.id); return true; });
    const pois  = parsePOIs(osm)
      .filter(p => { if (this.seenIds.has(p.id)) return false; this.seenIds.add(p.id); return true; });
    const waterAreas = parseWaterAreas(osm, nodeMap)
      .filter(w => { if (this.seenIds.has(w.id)) return false; this.seenIds.add(w.id); return true; });
    const waterways  = parseWaterways(osm, nodeMap)
      .filter(w => { if (this.seenIds.has(w.id)) return false; this.seenIds.add(w.id); return true; });

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
        const label = makeBuildingLabel(ring, bTop, truncateLabel(name));
        if (label) this.buildingLabelGroup.add(label);
      }
    }

    // POI signs laid on the nearest building wall (floating fallback if none near).
    for (const p of pois) {
      this.poiLabelGroup.add(makePoiLabel(p.x, p.z, truncateLabel(p.name), this.footprints));
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
    if (waterAreas.length || waterways.length) {
      const am = buildWaterAreaMesh(waterAreas, this.mats.water);
      const wm = buildWaterLines(waterways, this.mats.water);
      if (am) group.add(am);
      if (wm) group.add(wm);
    }

    this.scene.add(group);
    this._updateStatus();
  }

  // Compute the bbox + tile keys for a square region of `radius` tiles around (camX,camZ).
  regionTiles(camX, camZ, radius) {
    const { lat, lon } = worldToGeo(camX, camZ);
    const { tx, ty }   = latLonToTile(lat, lon);
    const keys = [];
    for (let dy = -radius; dy <= radius; dy++)
      for (let dx = -radius; dx <= radius; dx++)
        keys.push(this.key(tx + dx, ty + dy));
    const bbox = {
      south: (ty - radius) * TILE_LAT, north: (ty + radius + 1) * TILE_LAT,
      west:  (tx - radius) * TILE_LON, east:  (tx + radius + 1) * TILE_LON,
    };
    return { keys, bbox };
  }

  // Fetch with retry, returning OSM data or null on give-up. Only fires onStatus
  // on retries/failures (not the initial attempt) so it can run in parallel with
  // terrain loading without overwriting the caller's status message.
  async _fetchWithRetry(bbox, label, onStatus = () => {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        if (attempt > 0) onStatus(`Network busy — retrying (${attempt}/6)…`, 0.45);
        return await fetchOSMBbox(bbox);
      } catch (err) {
        console.warn(`Region ${label}:`, err.message);
        if (attempt < 6) { await sleep([800, 1500, 3000, 5000, 8000, 8000][attempt]); continue; }
        onStatus('Map data unavailable — starting with what loaded.', 1);
        return null;
      }
    }
  }

  // Mark tiles as loading, ingest pre-fetched OSM, then settle all tile states.
  _settleRegion(keys, osm) {
    for (const k of keys) if (!this.tiles.has(k)) this.tiles.set(k, 'loading');
    if (osm) this._ingest(osm);
    for (const k of keys) {
      this.tiles.set(k, osm ? 'done' : 'failed');
      if (!this.settled.has(k)) { this.settled.add(k); this.tilesLoaded++; }
    }
  }

  // Fetch a whole region in a SINGLE Overpass request (far fewer requests than
  // one-per-tile, so much less likely to be rate-limited), then ingest it and
  // mark every covered tile settled.
  async loadRegion(keys, bbox, label, onStatus = () => {}) {
    const osm = await this._fetchWithRetry(bbox, label, onStatus);
    if (osm) { onStatus('Building the city…', 0.9); await sleep(0); }
    this._settleRegion(keys, osm);
  }

  // Fetch named POIs for a region and add them to the POI label group. Called in
  // the background after reveal — POIs are off by default (F2 to show).
  async loadPOIs(bbox) {
    try {
      const osm = await fetchOSMPOIs(bbox);
      const pois = parsePOIs(osm)
        .filter(p => { if (this.seenIds.has(p.id)) return false; this.seenIds.add(p.id); return true; });
      for (const p of pois)
        this.poiLabelGroup.add(makePoiLabel(p.x, p.z, truncateLabel(p.name), this.footprints));
    } catch (err) {
      console.warn('POI load failed:', err.message);
    }
  }

  async _loadTile(tx, ty, k) {
    try {
      this._ingest(await fetchOSMBbox(tileToBBox(tx, ty)));
      this.tiles.set(k, 'done');
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

  // Touch controls (mobile): hold 200 ms → walk forward continuously while held;
  // drag at any time → look around. Both work simultaneously so you can steer
  // while moving by holding and dragging in the same gesture.
  // 2.5× sensitivity vs mouse since there is no pointer-lock damping on touch.
  const TOUCH_LOOK_SPEED = LOOK_SPEED * 2.5;
  let touchLast = null, touchHoldTimer = null;

  domElement.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touchHoldTimer = setTimeout(() => keys.add('KeyW'), 200);
    }
    e.preventDefault();
  }, { passive: false });

  domElement.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && touchLast) {
      const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
      const dx = cx - touchLast.x, dy = cy - touchLast.y;
      touchLast = { x: cx, y: cy };
      yaw  += -dx * TOUCH_LOOK_SPEED;
      pitch = Math.max(-Math.PI * 0.499, Math.min(Math.PI * 0.499, pitch + -dy * TOUCH_LOOK_SPEED));
      applyRotation();
      dispatcher.dispatchEvent({ type: 'change' });
    }
    e.preventDefault();
  }, { passive: false });

  domElement.addEventListener('touchend', () => {
    touchLast = null;
    clearTimeout(touchHoldTimer);
    touchHoldTimer = null;
    keys.delete('KeyW');
  });

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

// ─── Polygon bird mesh ────────────────────────────────────────────────────────

// Patch a built-in material so its vertices route through the fisheye projection
// (shared uFish* uniforms) — used for the bird, which isn't a ShaderMaterial.
function applyFisheye(mat) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fishUniforms());
    shader.vertexShader = FISH_PROJ_GLSL + '\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      'vec4 mvPosition = modelViewMatrix * vec4(transformed, 1.0); vFishView = mvPosition.xyz; gl_Position = projectVertex(mvPosition);',
    );
  };
  return mat;
}

function buildBirdMesh() {
  const group   = new THREE.Group();
  const matBody = applyFisheye(new THREE.MeshBasicMaterial({ color: 0x2c8fc7, wireframe: true }));
  const matWing = applyFisheye(new THREE.MeshBasicMaterial({ color: 0x46c0ff, wireframe: true }));
  const matBeak = applyFisheye(new THREE.MeshBasicMaterial({ color: 0xff9a3c, wireframe: true }));

  // Bird faces −Z (Three.js default forward). Dorsal (top-down) layout:
  //  −Z = head/beak, +Z = tail, ±X = wingtips, +Y = up (back).

  // ── Body: elongated ellipsoid, gives the lat/long grid of the reference ──
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 16, 11), matBody);
  body.scale.set(0.42, 0.40, 1.30);     // narrow, slightly flat, long
  group.add(body);

  // ── Head: smaller ellipsoid blended into the front ──
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 12, 9), matBody);
  head.scale.set(0.27, 0.27, 0.34);
  head.position.set(0, 0.05, -0.66);
  group.add(head);

  // ── Beak: slim cone pointing −Z ──
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.36, 4, 1), matBeak);
  beak.rotation.x = -Math.PI / 2;       // +Y axis → −Z
  beak.position.set(0, 0.04, -0.92);
  group.add(beak);

  // Build a triangulated "fan" sheet from a leading-edge curve (base[]) to a
  // trailing-edge curve (tip[]). The wireframe of the quads reads as rows of
  // feathers radiating outward — the look of the reference wing/tail.
  function makeFan(base, tip, mat) {
    const n = base.length;
    const pos = [];
    for (const p of base) pos.push(p.x, p.y, p.z);
    for (const p of tip)  pos.push(p.x, p.y, p.z);
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const b0 = i, b1 = i + 1, t0 = n + i, t1 = n + i + 1;
      idx.push(b0, b1, t1,  b0, t1, t0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    return new THREE.Mesh(geo, mat);
  }

  // ── Wings: a swept fan of feathers from shoulder to wingtip ──
  function buildWing(sx) {
    const n = 16;
    const base = [], tip = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const e = t * t * (3 - 2 * t);          // smoothstep for a curved edge
      // Leading edge: shoulder → wrist, sweeping slightly back & dropping.
      base.push(new THREE.Vector3(
        sx * (0.17 + 1.55 * t),
        0.07 - 0.10 * e,
        -0.20 + 0.40 * e,
      ));
      // Trailing edge: wider and swept further back, drooping at the tips.
      tip.push(new THREE.Vector3(
        sx * (0.30 + 1.95 * t),
        0.03 - 0.22 * e,
        0.22 + 0.78 * e,
      ));
    }
    return makeFan(base, tip, matWing);
  }
  group.add(buildWing( 1));
  group.add(buildWing(-1));

  // ── Tail: a fan of feathers spreading behind the body ──
  function buildTail() {
    const n = 11;
    const base = [], tip = [];
    const rootZ = 0.55;
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const a = (t - 0.5) * 2;                 // −1 … 1 across the fan
      base.push(new THREE.Vector3(a * 0.10, 0.01, rootZ));
      tip.push(new THREE.Vector3(
        a * 0.42,
        -0.05,
        rootZ + 0.62 - Math.abs(a) * 0.14,     // outer feathers a touch shorter
      ));
    }
    return makeFan(base, tip, matBody);
  }
  group.add(buildTail());

  return group;
}

// ─── Third-person bird controls ───────────────────────────────────────────────

function createBirdControls(camera, domElement, collision) {
  // Camera look (controlled by mouse / A-D) is decoupled from the bird's heading.
  // The mouse orbits the camera freely; the bird only turns to follow the camera
  // while you're actively thrusting (holding left mouse / W).
  let camYaw      = 0;
  let camPitch    = 0;     // + = looking up. NOT inverted.
  let headYaw     = 0;     // bird's facing/flight heading (eases toward camYaw while thrusting)
  let headPitch   = 0;
  let roll        = 0;     // smoothed bank angle applied to the bird mesh
  let fisheyeMode = true;   // speed-driven fisheye is on by default (F3 toggles off)

  const LOOK_SPEED  = 0.00175;
  const MOVE_SPEED  = 0.35;
  const MOVE_MAX    = MOVE_SPEED * 3;  // top speed (non-sprint) — 1.5× the previous max
  const ACCEL_TIME  = 3.0;             // seconds from standstill to top speed
  const DECEL_TIME  = 1.5;             // seconds to coast back to a stop
  const BRAKE_TIME  = 0.5;             // seconds to brake to a stop when S is held
  const TURN_SPEED  = 0.022;   // A/D yaw turn rate (radians per frame)
  const LIFT_SPEED  = 0.30;    // spacebar ascent per frame
  const MIN_CLEAR   = 0.3;     // can skim almost to the ground
  const CAM_FLOOR_CLEAR = 1.2; // keep the orbit camera this far above the floor
  const BIRD_RADIUS = 2.0;     // collision radius against building walls
  const RAMP_GAIN   = 1.3;     // head-on into a wall → climb at 1.3× the blocked speed
  const PITCH_LIMIT = 1.1;     // clamp so you can't loop over the top
  const TOUCH_SPEED = LOOK_SPEED * 2.5;

  // Speed-driven fisheye: the warp eases in from a normal view (rest) to a full
  // fisheye at top speed, and the angle grows wider the faster you go.
  const FOV_REST_DEG   = 120;  // angle the warp eases up from (barely visible at low speed)
  const FOV_MAX_DEG    = 220;  // at top non-sprint speed
  const FOV_SPRINT_DEG = 250;  // at top sprint speed
  const FOV_DIVE_DEG   = 290;  // keeps widening past sprint speed while diving
  const DIVE_BOOST     = MOVE_MAX * 2;  // extra top speed gained in a full vertical dive

  let lastTime    = performance.now();
  let mouseThrust = false;     // true while left mouse held (with pointer locked)

  const birdPos = new THREE.Vector3(0, BIRD_HEIGHT, 0);
  const _look    = new THREE.Vector3();
  const _heading = new THREE.Vector3();
  const _vel     = new THREE.Vector3();  // current velocity vector (m/frame); coasts naturally
  const _euler   = new THREE.Euler(0, 0, 0, 'YXZ');

  // Auto-pilot pitch easing. When a bounce or wall-ramp redirects the bird, the
  // velocity changes instantly (physics) but the bird's nose eases toward the new
  // pitch over a few frames so the redirect reads as a smooth curve, not a snap.
  // null = no redirect in progress; otherwise the target pitch in radians.
  let _pitchTarget = null;
  let _bounceLock  = 0;       // frames a fresh ground bounce overrides left-click steering
  const PITCH_EASE = 0.14;    // per-frame approach toward the target pitch

  // Wall-ramp state. A head-on building hit sends the bird climbing vertically up
  // the face (parallel to the wall); once it clears the roof it peels forward at a
  // shallow climb. We remember the approach direction + speed to resume with.
  // predictive: nose-rotation has begun but velocity hasn't been snapped yet.
  const _ramp = { active: false, predictive: false, dirX: 0, dirZ: 0, speed: 0, camPitch: 0 };
  const RAMP_CLIMB_PITCH = 1.45;            // ~83°: nose near-vertical up the wall
  const RAMP_EXIT_ANGLE  = Math.PI / 6;     // 30° forward climb once over the roof
  const WALL_LOOK        = 3;               // frames ahead for predictive wall detection

  const keys   = new Set();
  const typing = e => e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
  window.addEventListener('keydown', e => {
    if (typing(e)) return;
    keys.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', e => keys.delete(e.code));

  // Unit vector pointing where the camera looks (full 3D, includes pitch).
  function getLook() {
    _euler.set(camPitch, camYaw, 0);
    _look.set(0, 0, -1).applyEuler(_euler);
    return _look;
  }

  // Unit vector for the direction the bird is actually facing (its heading).
  function getHeading() {
    _euler.set(headPitch, headYaw, 0);
    _heading.set(0, 0, -1).applyEuler(_euler);
    return _heading;
  }

  function updateCamera() {
    // Orbit camera: the camera circles the bird at the mouse-driven angle
    // (camYaw/camPitch) and always looks AT the bird, so the bird stays centred.
    // The bird's own heading (headYaw) is independent — mouse-look never rotates
    // the bird mesh, only the camera's vantage point around it.
    const look    = getLook();
    // Follow distance eases from the normal framing (at rest / fisheye off) to the
    // closer fisheye framing as the speed-driven warp blends in.
    const b       = fisheyeMode ? FISH_U.uFishBlend.value : 0;
    const camBack = BIRD_CAM_BACK + (FISH_CAM_BACK - BIRD_CAM_BACK) * b;
    const camUp   = BIRD_CAM_UP   + (FISH_CAM_UP   - BIRD_CAM_UP)   * b;
    camera.position.set(
      birdPos.x - look.x * camBack,
      birdPos.y - look.y * camBack + camUp,
      birdPos.z - look.z * camBack,
    );
    // Keep the camera from dipping below the ground when the bird skims low:
    // sample the floor under the camera's own xz and clamp its y to a small
    // margin above it. Otherwise the orbit camera pokes under the terrain and
    // the bottom of the screen clips through the ground behind the bird.
    if (collision && collision.floorFn) {
      const camFloor = collision.floorFn(camera.position.x, camera.position.z) + CAM_FLOOR_CLEAR;
      if (camera.position.y < camFloor) camera.position.y = camFloor;
    }
    camera.lookAt(birdPos.x, birdPos.y, birdPos.z);
  }

  domElement.addEventListener('click', () => {
    if (document.pointerLockElement !== domElement) domElement.requestPointerLock();
  });

  // Mouse = camera only (look around). Holding left mouse thrusts the bird in the
  // camera direction; the lock-acquiring click doesn't lurch because thrust only
  // engages once the pointer is already locked.
  domElement.addEventListener('mousedown', e => {
    if (e.button === 0 && document.pointerLockElement === domElement) mouseThrust = true;
  });
  window.addEventListener('mouseup', e => { if (e.button === 0) mouseThrust = false; });
  window.addEventListener('blur', () => { mouseThrust = false; });

  // Non-inverted: mouse up → look up (pitch increases), mouse right → turn right.
  document.addEventListener('mousemove', e => {
    if (document.pointerLockElement !== domElement) return;
    camYaw   += -e.movementX * LOOK_SPEED;
    camPitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camPitch - e.movementY * LOOK_SPEED));
    updateCamera();
    dispatcher.dispatchEvent({ type: 'change' });
  });

  domElement.addEventListener('contextmenu', e => e.preventDefault());

  let touchLast = null, touchHoldTimer = null;
  domElement.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      touchHoldTimer = setTimeout(() => keys.add('KeyW'), 200);
    }
    e.preventDefault();
  }, { passive: false });

  domElement.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && touchLast) {
      const cx = e.touches[0].clientX, cy = e.touches[0].clientY;
      const dx = cx - touchLast.x, dy = cy - touchLast.y;
      touchLast = { x: cx, y: cy };
      camYaw   += -dx * TOUCH_SPEED;
      camPitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, camPitch - dy * TOUCH_SPEED));
      updateCamera();
      dispatcher.dispatchEvent({ type: 'change' });
    }
    e.preventDefault();
  }, { passive: false });

  domElement.addEventListener('touchend', () => {
    touchLast = null;
    clearTimeout(touchHoldTimer);
    touchHoldTimer = null;
    keys.delete('KeyW');
  });

  let prevHeadYaw = 0;

  const dispatcher = Object.assign(new THREE.EventDispatcher(), {
    birdPos,
    getYaw()   { return headYaw; },
    getPitch() { return headPitch; },
    getRoll()  { return roll; },
    getSpeed() { return _vel.length(); },
    setFisheye(on) { fisheyeMode = on; updateCamera(); },
    init(x, y, z) { birdPos.set(x, y, z); updateCamera(); },
    update() {
      const now    = performance.now();
      const dt     = Math.min((now - lastTime) / 1000, 0.1);  // seconds, capped
      lastTime     = now;

      const sprint = (keys.has('ShiftLeft') || keys.has('ShiftRight')) ? 2 : 1;
      let moved = false;

      // A/D turn the bird's heading; shift camYaw by the same delta so the
      // camera orbit offset relative to the bird is preserved (no snap).
      if (keys.has('KeyA')) { headYaw += TURN_SPEED; camYaw += TURN_SPEED; moved = true; }
      if (keys.has('KeyD')) { headYaw -= TURN_SPEED; camYaw -= TURN_SPEED; moved = true; }

      // Velocity-based movement. _vel carries both direction and speed so coasting
      // is natural — just bleed the magnitude each frame when not thrusting.
      // S is the brake (not reverse): it overrides the throttle and decelerates
      // the current velocity quickly, regardless of which way the bird is facing.
      const braking   = keys.has('KeyS');
      const thrusting = !braking && (keys.has('KeyW') || mouseThrust);
      const topSpeed  = MOVE_MAX * sprint;

      if (braking) {
        const curSpeed = _vel.length();
        const brake    = MOVE_MAX / BRAKE_TIME * dt;
        if (curSpeed <= brake) _vel.set(0, 0, 0);
        else                   _vel.multiplyScalar((curSpeed - brake) / curSpeed);
      } else if (thrusting) {
        // Build desired direction. W and left-click are NOT additive in speed —
        // directions are summed then normalised so holding both doesn't go faster.
        const tx = new THREE.Vector3();
        if (keys.has('KeyW'))  tx.add(getHeading());
        if (mouseThrust) {
          tx.add(getLook());
          headYaw   += (camYaw   - headYaw)   * 0.12;
          if (!_ramp.active) headPitch += (camPitch - headPitch) * 0.12;
        }
        if (tx.lengthSq() > 1e-6) {
          tx.normalize();
          // Diving (tx.y < 0) builds speed PAST the normal top speed and pulls
          // harder the steeper the dive; pulling level lets the extra speed bleed
          // off through the normal deceleration instead of snapping back.
          const dive     = Math.max(0, -tx.y);                 // 0 level … 1 straight down
          const cap      = topSpeed + DIVE_BOOST * dive;       // dive can exceed top speed
          const accel    = (topSpeed / ACCEL_TIME) * (1 + 2 * dive);
          const curSpeed = _vel.length();
          // Never bleed speed while actively thrusting — only accelerate up to cap
          // or hold steady if already at/above it. Speed only decays in the else branch.
          const newSpeed = curSpeed >= cap
            ? curSpeed
            : Math.min(curSpeed + accel * dt, cap);
          _vel.copy(tx).multiplyScalar(newSpeed);
        }
      } else {
        // Coast: shrink magnitude, keep direction.
        const curSpeed = _vel.length();
        const decel    = MOVE_MAX / DECEL_TIME * dt;
        if (curSpeed <= decel) {
          _vel.set(0, 0, 0);
        } else {
          _vel.multiplyScalar((curSpeed - decel) / curSpeed);
        }
      }

      if (_vel.lengthSq() > 1e-8) {
        const cf = collision && collision.fn;
        // During an active wall climb, force vertical movement before computing
        // nx/nz/ny so the collision test checks straight above (has the wall
        // cleared?) rather than in the heading direction. Without this, as
        // headPitch rotates toward vertical the heading-based velocity has
        // nx ≈ birdPos.x and ny well above the building, causing a premature
        // peel-off that oscillates and feels like being stuck.
        if (_ramp.active && !_ramp.predictive) {
          _vel.set(0, _ramp.speed, 0);
        }
        const nx = birdPos.x + _vel.x, nz = birdPos.z + _vel.z, ny = birdPos.y + _vel.y;

        // ── Predictive wall detection ──────────────────────────────────────────
        // Check WALL_LOOK frames ahead at current height. If a head-on wall is
        // coming (both horizontal slides also blocked at that lookahead position),
        // init the ramp state now so the nose starts rotating before impact.
        // Velocity is NOT snapped yet — that happens on the actual collision frame.
        // This gives the bird a smooth curved approach instead of an abrupt snap.
        if (cf && !_ramp.active && !cf(birdPos.x, birdPos.z, birdPos.y, BIRD_RADIUS)) {
          const px = birdPos.x + _vel.x * WALL_LOOK, pz = birdPos.z + _vel.z * WALL_LOOK;
          if (cf(px, pz, birdPos.y, BIRD_RADIUS)
              && cf(px, birdPos.z, birdPos.y, BIRD_RADIUS)
              && cf(birdPos.x, pz, birdPos.y, BIRD_RADIUS)) {
            const horizSpeed = Math.hypot(_vel.x, _vel.z);
            _ramp.active     = true;
            _ramp.predictive = true;
            _ramp.dirX       = horizSpeed > 1e-4 ? _vel.x / horizSpeed : getHeading().x;
            _ramp.dirZ       = horizSpeed > 1e-4 ? _vel.z / horizSpeed : getHeading().z;
            _ramp.speed      = Math.max(horizSpeed, MOVE_SPEED);
            _pitchTarget     = RAMP_CLIMB_PITCH;   // begin nose rotation early
          }
        }

        // ── Collision + ramp ───────────────────────────────────────────────────
        if (cf && cf(nx, nz, ny, BIRD_RADIUS)) {
          // Slide tests use current y — building walls are vertical so clearance is
          // a horizontal question. Skip slides entirely once ramp is active.
          let doRamp = _ramp.active;
          if (!doRamp) {
            if      (!cf(nx,        birdPos.z, birdPos.y, BIRD_RADIUS)) { birdPos.x = nx; _vel.z = 0; birdPos.y = ny; }
            else if (!cf(birdPos.x, nz,        birdPos.y, BIRD_RADIUS)) { birdPos.z = nz; _vel.x = 0; birdPos.y = ny; }
            else    { doRamp = true; }
          }
          if (doRamp) {
            if (!_ramp.active) {
              // Fresh ramp — no predictive phase; capture everything now.
              _ramp.active     = true;
              _ramp.predictive = false;
              _ramp.camPitch   = camPitch;
              const horizSpeed = Math.hypot(_vel.x, _vel.z);
              _ramp.dirX  = horizSpeed > 1e-4 ? _vel.x / horizSpeed : getHeading().x;
              _ramp.dirZ  = horizSpeed > 1e-4 ? _vel.z / horizSpeed : getHeading().z;
              _ramp.speed = Math.max(horizSpeed, MOVE_SPEED);
            } else if (_ramp.predictive) {
              // Predictive phase ends — wall actually reached; freeze camera now.
              _ramp.predictive = false;
              _ramp.camPitch   = camPitch;
            }
            _vel.set(0, _ramp.speed, 0);
            birdPos.y += _ramp.speed;
            _pitchTarget = RAMP_CLIMB_PITCH;
          }
        } else {
          if (_ramp.active && !_ramp.predictive) {
            // Cleared the roof: peel off into a 30° forward climb.
            const v = _ramp.speed;
            const h = v * Math.cos(RAMP_EXIT_ANGLE);
            _vel.set(_ramp.dirX * h, v * Math.sin(RAMP_EXIT_ANGLE), _ramp.dirZ * h);
            _pitchTarget     = RAMP_EXIT_ANGLE;
            _ramp.active     = false;
            _ramp.predictive = false;
          } else if (_ramp.active && _ramp.predictive) {
            // Still in predictive approach — re-verify wall is still ahead.
            // If the user has steered away, cancel the predictive state.
            const cpx = birdPos.x + _vel.x * WALL_LOOK, cpz = birdPos.z + _vel.z * WALL_LOOK;
            if (!cf || !cf(cpx, cpz, birdPos.y, BIRD_RADIUS)) {
              _ramp.active     = false;
              _ramp.predictive = false;
              _pitchTarget     = null;
            }
          }
          birdPos.add(_vel);
        }
        moved = true;
      }

      // Speed-driven fisheye with a very slow onset: ~5% warp at 140 km/h
      // (tt≈0.62), rising to full fisheye at top speed (227 km/h). The high
      // power keeps low/medium cruising in plain perspective and only swings
      // the lens in near the top. The angle widens 120°→220° over the first
      // band, then 220°→250° through the sprint band.
      const tt    = _vel.length() / MOVE_MAX;
      const e     = Math.min(tt, 1);
      const blend = Math.pow(e, 6.2);  // 5% at tt≈0.62 (140 km/h), 100% at top
      // FOV widens with speed: rest→max over band 0-1, max→sprint over 1-2, then
      // keeps opening sprint→dive over 2-4 as a dive pushes past top speed.
      let fovDeg;
      if (tt <= 1)      fovDeg = FOV_REST_DEG   + (FOV_MAX_DEG    - FOV_REST_DEG)   * tt;
      else if (tt <= 2) fovDeg = FOV_MAX_DEG    + (FOV_SPRINT_DEG - FOV_MAX_DEG)    * (tt - 1);
      else              fovDeg = FOV_SPRINT_DEG + (FOV_DIVE_DEG   - FOV_SPRINT_DEG) * Math.min((tt - 2) / 2, 1);
      FISH_U.uFishBlend.value   = fisheyeMode ? blend : 0;
      FISH_U.uFishHalfFov.value = (fovDeg * Math.PI / 180) / 2;

      // Spacebar gains elevation.
      if (keys.has('Space')) { birdPos.y += LIFT_SPEED * sprint; moved = true; }

      // Stay above the floor: terrain outside buildings, rooftop when over one
      // (so a dive lands the bird on the roof instead of sinking through it).
      // A sharp downward hit bounces the bird back up: reflect the vertical
      // velocity (with slight damping) so fast dives arc back toward the sky.
      const floorY = (collision && collision.floorFn)
        ? collision.floorFn(birdPos.x, birdPos.z)
        : (terrain ? terrain.sample(birdPos.x, birdPos.z) : 0);
      if (birdPos.y < floorY + MIN_CLEAR) {
        birdPos.y = floorY + MIN_CLEAR;
        if (_vel.y < -0.01) {
          _vel.y = -_vel.y * 0.75;
          // Aim the bird's nose at the reflected direction, but ease into it over
          // the next frames (below) instead of snapping so the arc reads smoothly.
          const horizSpeed = Math.hypot(_vel.x, _vel.z);
          _pitchTarget = Math.atan2(_vel.y, Math.max(horizSpeed, 0.001));
          // Hold the redirect for a few frames so it can't be cancelled by a
          // held left-click before the bird actually lifts off the ground.
          _bounceLock = 12;
        }
      }

      // Animate any auto-pilot redirect (bounce or wall-ramp): ease headPitch toward
      // the target. During a wall ramp the camera is disassociated — camPitch stays
      // at the pre-impact vantage (so the player sees the bird climbing) and only
      // resumes tracking once the ramp clears and the bird peels over the roof.
      // Left-click (mouseThrust) normally wins: it cancels the auto-pilot immediately
      // so the peel-off 30° angle doesn't lock the user out of steering. EXCEPTION:
      // a fresh ground bounce holds for _bounceLock frames so a held left-click
      // can't cancel it before the bird lifts off. Because left-click drives
      // velocity from getLook() (camPitch), we ease camPitch up too during the
      // lock — otherwise the thrust direction keeps pointing back into the ground
      // and the bird never leaves it. This is why the bounce "stopped working":
      // diving with left-click held cancelled the redirect the same frame.
      if (_bounceLock > 0) _bounceLock--;
      if (_pitchTarget !== null) {
        if (mouseThrust && !_ramp.active && _bounceLock === 0) {
          _pitchTarget = null;
        } else {
          headPitch += (_pitchTarget - headPitch) * PITCH_EASE;
          if (!_ramp.active) camPitch += (_pitchTarget - camPitch) * PITCH_EASE;
          if (Math.abs(_pitchTarget - headPitch) < 0.01) _pitchTarget = null;
        }
      }

      // Bank into turns: roll proportional to how fast the bird's heading changes.
      const dHead = headYaw - prevHeadYaw;
      prevHeadYaw = headYaw;
      const bankTarget = Math.max(-0.6, Math.min(0.6, dHead * 9));
      roll += (bankTarget - roll) * 0.15;   // smooth toward target / back to level

      if (moved) dispatcher.dispatchEvent({ type: 'change' });
      updateCamera();
    },
  });

  updateCamera();
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
        ...fishUniforms(),
      },
      transparent: true,
      depthWrite: true,   // solid default: ground occludes underground tunnels/trains
      vertexShader: /* glsl */`
        varying vec2 vXZ;
        ${FISH_PROJ_GLSL}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vXZ = world.xz;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFishView = mv.xyz;
          gl_Position = projectVertex(mv);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3  uGround;
        uniform float uFar;
        varying vec2  vXZ;
        ${FISH_FRAG_GLSL}
        void main() {
          // Ground-specific fisheye clip. The ground is one flat colour, so its
          // in-front peripheral fragments can fill the frame edge with no visible
          // smear — unlike detailed geometry. The shared fishClip() tightens its
          // angle below 90° at speed and discards that wide-angle front ground,
          // cutting a hard background seam across the bottom of the screen when
          // flying low. Here we ONLY discard fragments behind the camera plane
          // (vFishView.z > 0) past the FOV — those are the big flat triangles
          // that genuinely smear. Everything in front fills the frame.
          if (uFishBlend >= 0.001 && vFishView.z > 0.0) {
            float L = length(vFishView);
            float theta = acos(clamp(-vFishView.z / max(L, 1e-4), -1.0, 1.0));
            if (theta > uFishHalfFov) discard;
          }
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

  // Lights — only the bird uses MeshPhongMaterial; city is all ShaderMaterial so unaffected
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const sunLight = new THREE.DirectionalLight(0xfffde8, 0.9);
  sunLight.position.set(60, 150, 80);
  scene.add(sunLight);

  // Bird mesh — player avatar for third-person view
  const birdMesh = buildBirdMesh();
  birdMesh.position.set(0, BIRD_HEIGHT, 0);
  scene.add(birdMesh);

  const controls = createBirdControls(camera, renderer.domElement, collision);

  function onResize() {
    const w = innerWidth, h = innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    FISH_U.uFishAspect.value = w / h;
  }
  window.addEventListener('resize', onResize);
  // visualViewport fires when the iOS address bar slides in/out (innerHeight
  // doesn't change in that case, but the visible area does).
  if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);

  const trainRef  = { system: null };
  const labelsRef = { bldgGroup: null, poiGroup: null };
  const LABEL_DIST = 250;
  let fisheyeActive = true;   // speed-driven fisheye on by default; F3 toggles it off
  let lastTime = performance.now();
  const speedEl = document.getElementById('speed');

  // ── Single-pass fisheye ────────────────────────────────────────────────────
  // The whole scene is rendered ONCE; the fisheye warp lives in every vertex
  // shader (FISH_PROJ_GLSL), toggled by the shared uFishOn uniform. This is as
  // cheap as normal flight (1 pass vs the old cubemap's 6). Frustum culling is
  // disabled while active so geometry off to the sides (visible at 220°, but
  // outside the camera's normal frustum) isn't culled before it can be warped.
  // Disable culling while fisheye is active (peripheral geometry visible at 220°
  // lies outside the normal frustum). Preserve each object's original setting so
  // objects that opt out of culling (e.g. trains) keep their behaviour on restore.
  function fishCullEnter() {
    scene.traverse(o => {
      if (!(o.isMesh || o.isLine || o.isLineSegments || o.isPoints)) return;
      if (o.userData._fc === undefined) o.userData._fc = o.frustumCulled;
      o.frustumCulled = false;
    });
  }
  function fishCullExit() {
    scene.traverse(o => {
      if (o.userData._fc !== undefined) { o.frustumCulled = o.userData._fc; delete o.userData._fc; }
    });
  }

  // F3 toggles fisheye + closer follow camera.
  window.addEventListener('keydown', e => {
    if (e.code === 'F3') {
      e.preventDefault();
      fisheyeActive = !fisheyeActive;
      FISH_U.uFishOn.value = fisheyeActive ? 1 : 0;
      if (fisheyeActive) fishCullEnter(); else fishCullExit();
      controls.setFisheye(fisheyeActive);
    }
  });

  (function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.1);
    lastTime  = now;
    controls.update();
    if (speedEl && dt > 0) {
      const kmh = (controls.getSpeed() / dt * 3.6).toFixed(0);
      speedEl.textContent = kmh + ' km/h';
    }
    updateAreaName(controls.birdPos.x, controls.birdPos.z, now);
    // Sync bird mesh: position + flight orientation (yaw, nose pitch, bank roll)
    birdMesh.position.copy(controls.birdPos);
    birdMesh.position.y += 0.1 * Math.sin(now * 0.002);   // gentle float bob
    birdMesh.rotation.set(controls.getPitch(), controls.getYaw(), controls.getRoll(), 'YXZ');
    if (trainRef.system) trainRef.system.update(dt);
    // Declutter: only keep labels near the camera visible.
    const cp = camera.position;
    // Labels are camera-facing billboards/sprites that use normal projection, so
    // they'd float detached from the warped world — hide them once the speed warp
    // engages (blend > 0). At rest the view is plain perspective, so they show.
    const warped = FISH_U.uFishBlend.value > 0.02;
    for (const grp of [labelsRef.bldgGroup, labelsRef.poiGroup]) {
      if (grp && grp.visible) {
        for (const s of grp.children) s.visible = !warped && cp.distanceTo(s.position) < LABEL_DIST;
      }
    }
    // Outline ribbons need the aspect every frame regardless of fisheye state.
    FISH_U.uFishAspect.value = camera.aspect;
    if (fisheyeActive) {
      // Newly streamed-in tiles must also skip frustum culling (they'd otherwise
      // pop at the periphery). Cheap: a handful of merged meshes per tile.
      fishCullEnter();
    }
    renderer.render(scene, camera);
  })();

  return { scene, camera, controls, trainRef, labelsRef, ground, renderer };
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

// Per-tile area names. Each tile (the same ~550 m grid the city geometry
// streams in) gets reverse-geocoded once; the result is cached by tile key so
// re-entering a known tile switches the label INSTANTLY with no network call.
// The label updates the moment you cross a tile boundary, not on a timer.
const _tileNames = new Map();   // tileKey → name string ('' = looked up, none found)
let   _rgTileKey = null;        // tile the label currently reflects
let   _rgLastFetch = -Infinity; // throttle floor for Nominatim (politeness only)

// The world is centred on the start location, so its tile is (0,0) in world
// space → tile of CENTER_LAT/LON. Cache the user's chosen name there so the
// label doesn't get reverse-geocoded away the moment the flight begins.
function seedStartTile(name) {
  const { tx, ty } = latLonToTile(CENTER_LAT, CENTER_LON);
  const key = `${tx},${ty}`;
  _tileNames.set(key, name);
  _rgTileKey = key;
}

function updateAreaName(worldX, worldZ, now) {
  const { lat, lon } = worldToGeo(worldX, worldZ);
  const { tx, ty } = latLonToTile(lat, lon);
  const key = `${tx},${ty}`;
  if (key === _rgTileKey) return;            // same tile → nothing to do

  // Known tile: switch instantly from cache.
  if (_tileNames.has(key)) {
    _rgTileKey = key;
    const name = _tileNames.get(key);
    if (name) setPlaceLabel(name);
    return;
  }

  // Unknown tile: reverse-geocode its CENTRE once. Throttle to ≥ 1.2 s between
  // network calls (Nominatim asks for ≤ 1 req/s) but don't block tile switching
  // for tiles we already know. _rgTileKey only advances on success, so a failed
  // or rate-limited lookup is retried when you next move.
  if (now - _rgLastFetch < 1200) return;
  _rgLastFetch = now;
  const bbox = tileToBBox(tx, ty);
  const clat = ((bbox.south + bbox.north) / 2).toFixed(5);
  const clon = ((bbox.west  + bbox.east)  / 2).toFixed(5);
  fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${clat}&lon=${clon}`,
    { headers: { 'Accept': 'application/json' } })
    .then(r => r.json())
    .then(d => {
      const a = d.address || {};
      const big   = a.city || a.town || a.village || a.county || '';
      const small = a.suburb || a.neighbourhood || a.quarter || a.city_district || '';
      const name  = big && small ? `${big} · ${small}` : big || small
                  || (d.display_name || '').split(',')[0] || '';
      _tileNames.set(key, name);
      _rgTileKey = key;
      if (name) setPlaceLabel(name);
    })
    .catch(() => { /* leave uncached so it retries on the next move */ });
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const loadMsg  = document.getElementById('load-msg');
  const statusEl = document.getElementById('status');

  pruneCache();   // drop expired Overpass entries (3-day TTL) in the background

  // Mutable ref so controls (created first) can call collision once tiles arrive
  const collision = { fn: null };
  const { scene, camera, controls, trainRef, labelsRef, ground, renderer } = initScene(collision);

  // Ask where to start, geocode it, then center the world there.
  const place = await promptLocation();
  setCenter(place.lat, place.lon);
  setPlaceLabel(place.shortLabel);
  seedStartTile(place.shortLabel);   // pin the chosen name to the start tile

  // Switch the loading screen from search mode to progress mode.
  document.getElementById('load-search').style.display = 'none';
  document.getElementById('place-me').style.display    = 'none';
  document.getElementById('search-msg').style.display  = 'none';
  document.getElementById('pbar-bg').style.display = '';

  const pbar    = document.getElementById('pbar');
  const loading = document.getElementById('loading');
  const setLoad = (text, frac) => {
    loadMsg.textContent = text;
    if (frac != null) pbar.style.width = `${Math.round(frac * 100)}%`;
  };

  const mats    = createMaterials();
  const manager = new TileManager(scene, mats, statusEl);

  // Wire collision after manager exists
  collision.fn      = (x, z, y, R) => manager.isInBuilding(x, z, y, R);
  collision.floorFn = (x, z)    => manager.getFloorHeight(x, z);

  // F1 = building names, F2 = POI labels (both off by default).
  labelsRef.bldgGroup = manager.buildingLabelGroup;
  labelsRef.poiGroup  = manager.poiLabelGroup;
  window.addEventListener('keydown', e => {
    if (e.code === 'F1') {
      e.preventDefault();
      manager.buildingLabelGroup.visible = !manager.buildingLabelGroup.visible;
    }
    if (e.code === 'F2') {
      e.preventDefault();
      manager.poiLabelGroup.visible = !manager.poiLabelGroup.visible;
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

  let lastCheck = 0;
  controls.addEventListener('change', () => {
    const now = Date.now();
    if (now - lastCheck > 1000) {
      lastCheck = now;
      manager.update(controls.birdPos.x, controls.birdPos.z);
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

  function reveal() {
    setLoad('Ready', 1);
    loading.classList.add('fade-out');
    setTimeout(() => loading.remove(), 800);
    syncTrains();
  }

  // Terrain tiles and core OSM data are independent network requests — fetch them
  // in parallel so the slower one doesn't make us wait for the faster one.
  const core = manager.regionTiles(0, 0, 1);
  const full = manager.regionTiles(0, 0, LOAD_RADIUS);
  manager.tilesTotal = core.keys.length;

  // Fetch terrain, core OSM, and the full ring OSM all in parallel — the ring
  // fetch usually completes around the same time as the others since it's
  // network-bound. Building both regions behind the loading screen means the
  // post-reveal freeze (ring geometry build on first use) never happens.
  setLoad('Loading terrain & map data…', 0.2);
  const [terrainResult, coreOsm, ringOsm] = await Promise.all([
    loadTerrain(),
    manager._fetchWithRetry(core.bbox, 'core', setLoad),
    manager._fetchWithRetry(full.bbox, 'ring'),
  ]);

  terrain = terrainResult;
  if (terrain) {
    // Displace ground plane vertices. PlaneGeometry is in XY before rotation.x = -π/2,
    // which maps local (x, y, z) → world (x, z, -y). To set world Y, set local Z.
    const pos = ground.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      pos.setZ(i, terrain.sample(pos.getX(i), -pos.getY(i)) - GROUND_SINK);
    }
    pos.needsUpdate = true;
    ground.geometry.computeVertexNormals();
    controls.init(0, terrain.sample(0, 0) + BIRD_HEIGHT, 0);
  }

  if (coreOsm) { setLoad('Building the city…', 0.80); await sleep(0); }
  manager._settleRegion(core.keys, coreOsm);

  // Build the full ring synchronously while still behind the loading screen so
  // no geometry build ever runs after reveal. seenIds dedup skips anything
  // already ingested by the core pass.
  if (ringOsm) { setLoad('Building surroundings…', 0.90); await sleep(0); }
  manager._settleRegion(full.keys, ringOsm);
  syncTrains();

  // Warm-up: compile all shaders and force GPU buffer uploads before the
  // overlay lifts so the bird is genuinely movable the instant it appears.
  setLoad('Warming up…', 0.97);
  renderer.compile(scene, camera);
  for (let i = 0; i < 5; i++) await nextFrame();

  reveal();
  // Background: only POIs remain (off by default; F2 to show).
  manager.loadPOIs(full.bbox);
}

main();
