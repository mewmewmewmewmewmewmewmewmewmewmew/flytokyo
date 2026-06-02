import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import earcut from 'earcut';
import { TrainSystem } from './train.js?v=12.42';
import { FISH_U, fishUniforms, FISH_PROJ_GLSL, FISH_FRAG_GLSL, TOON_GLSL } from './fisheye.js?v=12.42';
import { CHARACTERS, DEFAULT_CHARACTER } from './characters.js?v=12.42';

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

// Buildings/roads/water fade out over FADE_NEAR…FADE_FAR. FADE_NEAR matches the
// ground plane's own fade onset (FADE_FAR*0.5) on purpose: if the city started
// fading sooner than the ground, there'd be a mid-distance annulus where the
// ground is still opaque but the buildings have already vanished — which reads
// as a concentric "ring" of bare ground/road at the wide fisheye periphery.
// Keeping the onsets equal makes city and ground fade in lockstep (equal alpha
// at every distance), so the periphery is uniform with no ring.
const FADE_FAR    = 900;
const FADE_NEAR   = FADE_FAR * 0.5;   // 450 — aligned with the ground fade onset
const METRO_DEPTH   = -7;
const EYE_HEIGHT    = 1.6;
// Sink the ground mesh this far below true terrain so its coarse triangles can
// never poke up through the thin road/footpath decals laid just above terrain.
const GROUND_SINK   = 0.6;
// Bird (third-person) constants
const BIRD_HEIGHT   = 3.96;   // 13 ft above terrain
const BIRD_CAM_BACK = 8;      // metres behind bird
const BIRD_CAM_UP   = 2;      // metres above bird
const CAM_BANK      = 0.3;    // how much the camera rolls with the bird's bank (0=none, 1=full)
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
    this.baseElev = baseElev;   // elevation (m) at the world origin; spawn = 0
  }

  // Absolute elevation in metres above sea level (sea = 0), for water detection.
  sampleAbs(wx, wz) {
    const { lat, lon } = worldToGeo(wx, wz);
    return this.sampleLatLon(lat, lon);
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

// Decode raw PNG bytes into the {data,w,h,…} pixel record the sampler needs.
// Decoding from a blob: URL keeps the canvas un-tainted, so getImageData works
// without relying on the source server's CORS headers.
function decodeTerrainPng(buf, tx, ty) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const ctx2 = c.getContext('2d');
      ctx2.drawImage(img, 0, 0);
      const { data } = ctx2.getImageData(0, 0, img.width, img.height);
      URL.revokeObjectURL(url);
      resolve({ data, w: img.width, h: img.height, z: TERRAIN_ZOOM, tx, ty });
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// One elevation tile: served from the IndexedDB cache when present (no network),
// otherwise fetched from S3 as raw bytes and cached for next time. Returns the
// decoded pixel record, or null if both cache and network miss.
async function loadTerrainTile(tx, ty) {
  const key = `${TERRAIN_ZOOM}/${tx}/${ty}`;
  const hit = await cacheGet(key, TERRAIN_STORE);
  if (hit && hit.buf) return decodeTerrainPng(hit.buf, tx, ty);
  try {
    const res = await fetch(
      `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${TERRAIN_ZOOM}/${tx}/${ty}.png`,
      { mode: 'cors' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    cachePut(key, { ts: Date.now(), buf }, TERRAIN_STORE);   // fire-and-forget
    return decodeTerrainPng(buf, tx, ty);
  } catch { return null; }
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
  for (let ty = tyMin; ty <= tyMax; ty++)
    for (let tx = txMin; tx <= txMax; tx++)
      fetches.push(loadTerrainTile(tx, ty));

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

const CACHE_DB = 'tokyo3d', CACHE_STORE = 'overpass', TERRAIN_STORE = 'terrain';
const CACHE_TTL   = 3 * 24 * 60 * 60 * 1000;    // 3 days  — Overpass map data
const TERRAIN_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days — elevation is static
const QUERY_VERSION = 'v2';                  // bump to invalidate cache when the query changes

let _dbPromise = null;
function openCache() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    // v2 adds the terrain store. onupgradeneeded fires for fresh DBs and for the
    // v1→v2 bump alike; guard each create so it's safe either way.
    const req = indexedDB.open(CACHE_DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CACHE_STORE))   db.createObjectStore(CACHE_STORE);
      if (!db.objectStoreNames.contains(TERRAIN_STORE)) db.createObjectStore(TERRAIN_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  }).catch(() => null);   // private mode / blocked → run without a cache
  return _dbPromise;
}

async function cacheGet(key, store = CACHE_STORE) {
  const db = await openCache();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const r = db.transaction(store, 'readonly').objectStore(store).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror   = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function cachePut(key, value, store = CACHE_STORE) {
  const db = await openCache();
  if (!db) return;
  try {
    db.transaction(store, 'readwrite').objectStore(store).put(value, key);
  } catch { /* ignore */ }
}

// Drop expired entries once at startup so storage doesn't grow unbounded.
async function pruneCache() {
  const db = await openCache();
  if (!db) return;
  for (const [store, ttl] of [[CACHE_STORE, CACHE_TTL], [TERRAIN_STORE, TERRAIN_TTL]]) {
    try {
      const cur = db.transaction(store, 'readwrite').objectStore(store).openCursor();
      cur.onsuccess = e => {
        const c = e.target.result;
        if (!c) return;
        if (!c.value || Date.now() - c.value.ts > ttl) c.delete();
        c.continue();
      };
    } catch { /* ignore */ }
  }
}

// ─── Overpass ────────────────────────────────────────────────────────────────

// Known to send permissive CORS headers from the browser. Any one of these can
// be slow, rate-limit (429), or be unreachable at a given moment, so we don't
// trust a single one for the first try — see fetchOverpassRaced() below.
const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
// Rotate which endpoint leads each call (random start per page load) so
// back-to-back loads — e.g. the quiz "Play again" reload — don't always lead
// with the same server and trip its per-IP rate limit.
let _opIdx = (Math.random() * OVERPASS_ENDPOINTS.length) | 0;
function orderedEndpoints() {
  const n = OVERPASS_ENDPOINTS.length;
  const s = _opIdx++ % n;
  return Array.from({ length: n }, (_, k) => OVERPASS_ENDPOINTS[(s + k) % n]);
}

const OP_HEDGE_MS = 1400;   // head start for the lead mirror before fanning out

// One POST to a single Overpass mirror, validated. 30 s hard timeout.
async function overpassOnce(url, query) {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    'data=' + encodeURIComponent(query),
      signal:  ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} @ ${url}`);
    const data = await res.json();
    // Overpass returns 200 OK even on server-side timeout/error — detect via remark.
    if (data.remark && /error|timeout/i.test(data.remark))
      throw new Error(`Overpass: ${data.remark}`);
    if (!Array.isArray(data.elements))
      throw new Error('Overpass: malformed response (no elements array)');
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// Hedged request: fire the lead mirror immediately; if it hasn't answered within
// OP_HEDGE_MS — or it fails fast — fan out to the remaining mirrors and take
// whichever returns first. The visible "Network busy" retry then only happens
// when EVERY mirror fails at once (rare), instead of any time one flaky mirror
// happens to be first in a round-robin. A healthy lead mirror still answers
// alone, so we stay gentle on the free servers in the common case.
const _HEDGE = Symbol('hedge');
async function fetchOverpassRaced(query) {
  const eps = orderedEndpoints();
  const inflight = [];
  const fire = url => { const p = overpassOnce(url, query); inflight.push(p); return p; };

  const lead = fire(eps[0]);
  const winner = await Promise.race([
    lead.then(d => ({ ok: d }), e => ({ err: e })),
    sleep(OP_HEDGE_MS).then(() => _HEDGE),
  ]);
  if (winner !== _HEDGE && winner.ok) return winner.ok;   // lead won outright

  // Lead is slow (hedge elapsed) or already failed → bring up the backups and
  // race everything still in flight. Promise.any ignores the rejected ones.
  for (let i = 1; i < eps.length; i++) fire(eps[i]);
  try {
    return await Promise.any(inflight);
  } catch (agg) {
    const msgs = (agg && agg.errors || []).map(e => e.message).join(' · ');
    throw new Error(`all Overpass mirrors failed${msgs ? ': ' + msgs : ''}`);
  }
}

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
  const data = await fetchOverpassRaced(query);
  cachePut(cacheKey, { ts: Date.now(), data });   // fire-and-forget; 3-day TTL
  return data;
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
  const data = await fetchOverpassRaced(query);
  cachePut(cacheKey, { ts: Date.now(), data });
  return data;
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
    applyFisheye(new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
    })),
  );
  const off = 0.4;
  mesh.position.set(x + nx * off, y, z + nz * off);
  mesh.lookAt(mesh.position.x + nx, mesh.position.y, mesh.position.z + nz);  // face outward, upright
  mesh.renderOrder = 12;   // draw after the world so it's never hidden by curved walls
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
  const spr = new THREE.Sprite(applyFisheyeSprite(new THREE.SpriteMaterial({
    map: tex, transparent: true, depthWrite: false, depthTest: false,
  })));
  spr.scale.set(2 * aspect, 2, 1);
  spr.renderOrder = 12;   // draw after the world so it's never hidden by curved walls
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

function buildSurfaceMesh(buildings, terrainInfos, mat) {
  const pos = [], norm = [], col = [], idx = [];
  let v = 0;

  for (let bi = 0; bi < buildings.length; bi++) {
    const { ring, height } = buildings[bi];
    const n  = ring.length;
    const rc = heightColor(height);
    const wc = rc.clone().multiplyScalar(0.55);
    const flat = ring.flatMap(([x, z]) => [x, z]);
    const tris = earcut(flat);
    if (!tris.length) continue;

    const { topY, vertexH } = terrainInfos[bi];

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

function buildEdgesGeoMesh(buildings, terrainInfos, mat) {
  const allPos = [], allCol = [];

  for (let bi = 0; bi < buildings.length; bi++) {
    const { ring, height } = buildings[bi];
    const { topY, vertexH } = terrainInfos[bi];
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

    // Pre-compute terrain info once per building — used by footprints, surface
    // mesh, and edge mesh, so this avoids triple terrain sampling per building.
    const bldgTInfo = bldgs.map(({ ring, height }) => bldgTerrainInfo(ring, height));

    // Register footprints for collision; add a name label above named buildings.
    for (let bi = 0; bi < bldgs.length; bi++) {
      const { ring, height, name } = bldgs[bi];
      const xs = ring.map(p => p[0]), zs = ring.map(p => p[1]);
      const { topY: bTop } = bldgTInfo[bi];
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
      group.add(buildSurfaceMesh(bldgs, bldgTInfo, this.mats.surface));
      group.add(buildEdgesGeoMesh(bldgs, bldgTInfo, this.mats.wireframe));
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

// Sprite variant: Three.js sprite shaders compute mvPosition themselves (billboard
// math), so we must NOT overwrite it — just reroute the final gl_Position through
// the fisheye projection and record the view-space position in vFishView.
function applyFisheyeSprite(mat) {
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, fishUniforms());
    shader.vertexShader = FISH_PROJ_GLSL + '\n' + shader.vertexShader.replace(
      '#include <project_vertex>',
      'vFishView = mvPosition.xyz; gl_Position = projectVertex(mvPosition);',
    );
  };
  return mat;
}

// buildBirdMesh + bird animation now live in characters.js (the
// pluggable flight-character module). See CHARACTERS there.

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
  const MOVE_MAX    = MOVE_SPEED * 6;  // top speed — raised to absorb the removed sprint boost
  const ACCEL_TIME  = 3.0;             // seconds from standstill to top speed
  const DECEL_TIME  = 1.5;             // seconds to coast back to a stop
  const BRAKE_TIME  = 0.5;             // seconds to brake to a stop when Space is held
  const MIN_CLEAR   = 0.3;     // can skim almost to the ground
  const CAM_FLOOR_CLEAR = 1.2; // keep the orbit camera this far above the floor
  const BIRD_RADIUS = 2.0;     // collision radius against building walls
  const RAMP_GAIN   = 1.3;     // head-on into a wall → climb at 1.3× the blocked speed
  const PITCH_LIMIT = 1.1;     // clamp so you can't loop over the top
  const TOUCH_SPEED = LOOK_SPEED * 2.5;

  // Speed-driven fisheye: the warp eases in from a normal view (rest) to a full
  // fisheye at top speed, and the angle grows wider the faster you go.
  const FOV_REST_DEG   = 120;  // angle the warp eases up from (barely visible at low speed)
  const FOV_MAX_DEG    = 240;  // at top non-sprint speed
  const FOV_SPRINT_DEG = 270;  // at top sprint speed
  const FOV_DIVE_DEG   = 310;  // keeps widening past sprint speed while diving
  // Radial zoom that ramps in with the warp: 1 at rest → this at full fisheye. A
  // gentle magnification tightens the view a touch as you speed up.
  const FISH_ZOOM_MAX  = 1.3;
  const DIVE_BOOST     = MOVE_MAX * 2;  // extra top speed gained in a full vertical dive

  let lastTime    = performance.now();
  let mouseThrust = false;     // true while left mouse held (with pointer locked)

  const birdPos = new THREE.Vector3(0, BIRD_HEIGHT, 0);
  const _look    = new THREE.Vector3();
  const _heading = new THREE.Vector3();
  const _vel     = new THREE.Vector3();  // current velocity vector (m/frame); coasts naturally
  const _euler   = new THREE.Euler(0, 0, 0, 'YXZ');
  const _camUp   = new THREE.Vector3();  // scratch: rolled camera up-vector for banking
  const _viewDir = new THREE.Vector3();  // scratch: camera→bird direction (roll axis)

  // Auto-pilot pitch easing. When a bounce or wall-ramp redirects the bird, the
  // velocity changes instantly (physics) but the bird's nose eases toward the new
  // pitch over a few frames so the redirect reads as a smooth curve, not a snap.
  // null = no redirect in progress; otherwise the target pitch in radians.
  let _pitchTarget = null;
  let _bounceLock  = 0;       // frames a fresh ground bounce overrides left-click steering
  const PITCH_EASE = 0.14;    // per-frame approach toward the target pitch
  let _fishSmooth  = 0;       // temporally smoothed uFishBlend — eases the shader warp in/out
  let _czSmooth    = 0;       // temporally smoothed camera-zoom blend — eases follow-cam in/out

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
    // Follow distance eases from the normal framing (at rest) to the closer
    // fisheye framing as speed rises. Driven by a smoothstep on actual speed —
    // NOT the fisheye warp blend (uFishBlend = pow(speed,6.2)), which stays flat
    // then snaps near the top and made the zoom-in feel abrupt. smoothstep eases
    // in gradually and flattens as you approach max speed for a smooth arrival.
    const camBack = BIRD_CAM_BACK + (FISH_CAM_BACK - BIRD_CAM_BACK) * _czSmooth;
    const camUp   = BIRD_CAM_UP   + (FISH_CAM_UP   - BIRD_CAM_UP)   * _czSmooth;
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
    // Bank the camera with the bird: roll the up-vector around the view axis by a
    // fraction of the bird's bank angle so a turn tilts the horizon, but less than
    // the bird itself (CAM_BANK < 1) so the motion reads without being disorienting.
    _viewDir.set(birdPos.x, birdPos.y, birdPos.z).sub(camera.position).normalize();
    _camUp.set(0, 1, 0).applyAxisAngle(_viewDir, roll * CAM_BANK);
    camera.up.copy(_camUp);
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

  // ── Joystick touch control ───────────────────────────────────────────────
  // On touchstart we record the finger's origin. While the finger stays down:
  //   • thrust is on (fly toward camera direction)
  //   • the live offset from origin steers: horizontal → yaw turn rate,
  //     vertical → pitch, both proportional to distance from centre.
  // "Centre" is where the finger first landed, not the screen centre, so the
  // control works wherever the user touches. Max turn rate is reached at
  // JOYSTICK_RADIUS pixels from origin.
  const JOYSTICK_RADIUS = Math.min(innerWidth, innerHeight) * 0.28;
  const JOYSTICK_YAW    = 2.2;   // max yaw rate (rad/s) at full deflection
  const JOYSTICK_PITCH  = 1.6;   // max pitch rate (rad/s) at full deflection
  let touchOrigin = null;         // {x,y} where finger first landed
  let touchCurrent = null;        // {x,y} live finger position
  let touchHoldTimer = null;

  domElement.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      const t = e.touches[0];
      touchOrigin  = { x: t.clientX, y: t.clientY };
      touchCurrent = { x: t.clientX, y: t.clientY };
      touchHoldTimer = setTimeout(() => { mouseThrust = true; }, 120);
    }
    e.preventDefault();
  }, { passive: false });

  domElement.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && touchOrigin) {
      touchCurrent = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      if (touchHoldTimer) { clearTimeout(touchHoldTimer); touchHoldTimer = null; }
      mouseThrust = true;
    }
    e.preventDefault();
  }, { passive: false });

  domElement.addEventListener('touchend', () => {
    clearTimeout(touchHoldTimer);
    touchHoldTimer = null;
    touchOrigin  = null;
    touchCurrent = null;
    mouseThrust  = false;
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

      let moved = false;

      // Joystick: apply continuous yaw/pitch rate from the live finger offset.
      if (touchOrigin && touchCurrent) {
        const ox = (touchCurrent.x - touchOrigin.x) / JOYSTICK_RADIUS;
        const oy = (touchCurrent.y - touchOrigin.y) / JOYSTICK_RADIUS;
        const mag = Math.hypot(ox, oy);
        // Dead zone of 5 % radius, then cubic easing for fine control near centre.
        if (mag > 0.05) {
          const f = Math.min(mag, 1);
          const ease = f * f * f;   // cubic: very gradual near centre, sharp at edge
          const nx = ox / mag, ny = oy / mag;
          camYaw   -= nx * ease * JOYSTICK_YAW   * dt;
          camPitch  = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT,
                       camPitch - ny * ease * JOYSTICK_PITCH * dt));
          updateCamera();
        }
      }

      // Velocity-based movement. _vel carries both direction and speed so coasting
      // is natural — just bleed the magnitude each frame when not thrusting.
      // Space is the brake (not reverse): it overrides the throttle and decelerates
      // the current velocity quickly, regardless of which way the bird is facing.
      const braking   = keys.has('Space');
      const thrusting = !braking && mouseThrust;
      const topSpeed  = MOVE_MAX;

      if (braking) {
        const curSpeed = _vel.length();
        const brake    = MOVE_MAX / BRAKE_TIME * dt;
        if (curSpeed <= brake) _vel.set(0, 0, 0);
        else                   _vel.multiplyScalar((curSpeed - brake) / curSpeed);
      } else if (thrusting) {
        // Fly toward where the camera is aiming (left-click / touch thrust). The
        // bird's heading eases toward the camera so it banks into the turn.
        const tx = new THREE.Vector3();
        tx.add(getLook());
        headYaw   += (camYaw   - headYaw)   * 0.12;
        if (!_ramp.active) headPitch += (camPitch - headPitch) * 0.12;
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
      // Warp blend is a smoothstep across the upper speed band (50%→100%): it eases
      // in gradually and — crucially — arrives with ZERO slope at top speed, so the
      // lens stops slamming in near the top the way the old pow(e,6.2) curve did.
      const bt    = Math.max(0, (e - 0.5) / 0.5);
      const blend = bt * bt * (3 - 2 * bt);
      // FOV widens with speed: rest→max over band 0-1, max→sprint over 1-2, then
      // keeps opening sprint→dive over 2-4 as a dive pushes past top speed.
      let fovDeg;
      if (tt <= 1)      fovDeg = FOV_REST_DEG   + (FOV_MAX_DEG    - FOV_REST_DEG)   * tt;
      else if (tt <= 2) fovDeg = FOV_MAX_DEG    + (FOV_SPRINT_DEG - FOV_MAX_DEG)    * (tt - 1);
      else              fovDeg = FOV_SPRINT_DEG + (FOV_DIVE_DEG   - FOV_SPRINT_DEG) * Math.min((tt - 2) / 2, 1);
      // Light temporal smoothing on top of the eased curve handles the backtick
      // toggle and any residual jitter. The curve already eases its own ends, so a
      // gentler lag here keeps the warp from feeling like it trails the speed.
      const ease      = Math.min(1, dt * 6.0);
      _fishSmooth    += ((fisheyeMode ? blend : 0) - _fishSmooth) * ease;
      // Camera pull-in uses an ease-OUT curve (front-loaded, near-linear early)
      // so the camera tucks close to the bird EARLY in the speed ramp — before
      // the warp band opens — which hides the peripheral edge artifacts that
      // appear as the fisheye eases in.
      const cz        = 1 - (1 - e) * (1 - e);
      _czSmooth      += ((fisheyeMode ? cz : 0) - _czSmooth) * ease;
      FISH_U.uFishBlend.value   = _fishSmooth;
      FISH_U.uFishHalfFov.value = (fovDeg * Math.PI / 180) / 2;
      // Zoom tracks the warp blend: 1 at rest, FISH_ZOOM_MAX at full fisheye.
      FISH_U.uFishZoom.value    = 1 + (FISH_ZOOM_MAX - 1) * _fishSmooth;

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

  const groundGeo = new THREE.PlaneGeometry(8000, 8000, 256, 256);
  // Per-vertex absolute elevation (metres, sea level = 0), filled once terrain
  // loads. The shader paints anything at/below sea level as ocean — this is what
  // makes the sea/bay appear (OSM maps the coast as a line, not a fillable area,
  // so the ocean can't come from polygon data the way rivers/lakes do).
  groundGeo.setAttribute('aElev',
    new THREE.Float32BufferAttribute(new Float32Array(groundGeo.attributes.position.count), 1));
  const ground = new THREE.Mesh(
    groundGeo,
    new THREE.ShaderMaterial({
      uniforms: {
        uGround: { value: new THREE.Color(0xd8dce8) },
        uWater:  { value: new THREE.Color(0x4488bb) },   // matches river/lake fill
        uFar:    { value: FADE_FAR },
        uSeaOn:  { value: 0.0 },   // 0 until terrain loads (no false sea at y=0)
        ...fishUniforms(),
      },
      transparent: true,
      depthWrite: true,   // solid default: ground occludes underground tunnels/trains
      vertexShader: /* glsl */`
        attribute float aElev;
        varying vec2  vXZ;
        varying float vElev;
        ${FISH_PROJ_GLSL}
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vXZ = world.xz;
          vElev = aElev;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vFishView = mv.xyz;
          gl_Position = projectVertex(mv);
        }
      `,
      fragmentShader: /* glsl */`
        uniform vec3  uGround;
        uniform vec3  uWater;
        uniform float uFar;
        uniform float uSeaOn;
        varying vec2  vXZ;
        varying float vElev;
        ${FISH_FRAG_GLSL}
        void main() {
          // Ground-specific fisheye clip. The ground is one flat colour, so its
          // in-front peripheral fragments can fill the frame edge with no visible
          // smear — unlike detailed geometry. We ONLY discard fragments behind the
          // camera plane (vFishView.z > 0) past the FOV — those are the big flat
          // triangles that genuinely smear. Everything in front fills the frame.
          // Runs at every blend (incl. rest): under the unified w=1 projection the
          // GPU no longer near-plane clips behind-camera verts, so without this the
          // ground hemisphere behind the camera would smear the frame edge at rest.
          if (vFishView.z > 0.0) {
            float L = length(vFishView);
            float theta = acos(clamp(-vFishView.z / max(L, 1e-4), -1.0, 1.0));
            if (theta > uFishHalfFov) discard;
          }
          float d     = length(vXZ - cameraPosition.xz);
          float alpha = 1.0 - smoothstep(uFar * 0.5, uFar, d);
          if (alpha < 0.01) discard;
          // Sea: blend to water colour at/below sea level, with a soft shoreline
          // band (0 → 0.5 m) so the coast isn't a hard jaggy line.
          vec3 col = uGround;
          if (uSeaOn > 0.5) {
            float sea = 1.0 - smoothstep(-0.5, 0.5, vElev);
            col = mix(uGround, uWater, sea);
          }
          gl_FragColor = vec4(col, alpha);
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

  const mapsLinkEl = document.getElementById('maps-link');

  // Bird mesh — player avatar for third-person view
  const character = CHARACTERS[DEFAULT_CHARACTER];
  let birdMesh = character.build(applyFisheye);
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
  FISH_U.uFishOn.value = fisheyeActive ? 1 : 0;   // sync the shader gate to the default
  let lastTime = performance.now();
  const speedEl    = document.getElementById('speed');
  const compassEl  = document.getElementById('compass');
  const compassCtx = compassEl ? compassEl.getContext('2d') : null;
  // Compass sizing: set inline styles + bitmap directly from JS so we're not
  // fighting the global `canvas { inset:0 }` cascade. Mobile = full-width 32 px
  // strip flush to top; desktop = 360 × 48 centred pill.
  const _isTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches)
                || ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  let _cW = 360, _cH = 48, _cFlush = false;   // logical compass size; flush = edge-to-edge bar
  function syncCompassSize() {
    if (!compassEl) return;
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const mobile = _isTouch || vw <= 768;
    _cFlush = mobile;                          // mobile = flush full-width bar (no inset pill)
    _cW = mobile ? vw : 360;
    _cH = mobile ? 32 : 48;
    // Inline styles override everything including the global canvas rule.
    compassEl.style.setProperty('position', 'fixed', 'important');
    compassEl.style.setProperty('width',  _cW + 'px', 'important');
    compassEl.style.setProperty('height', _cH + 'px', 'important');
    compassEl.style.setProperty('left',   mobile ? '0px' : '50%', 'important');
    compassEl.style.setProperty('top',    '0px', 'important');
    compassEl.style.setProperty('right',  'auto', 'important');
    compassEl.style.setProperty('bottom', 'auto', 'important');
    compassEl.style.setProperty('transform', mobile ? 'none' : 'translateX(-50%)', 'important');
    // Bitmap: one real pixel per CSS pixel (skip DPR scaling — the tape is
    // text + lines, not photography; 1× is perfectly crisp on all screens).
    compassEl.width  = _cW;
    compassEl.height = _cH;
  }
  syncCompassSize();
  window.addEventListener('resize', syncCompassSize);
  window.addEventListener('orientationchange', syncCompassSize);
  window.addEventListener('load', syncCompassSize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', syncCompassSize);

  // Heading tape: a 360px-wide horizontal strip.  The tape pixel-scrolls so each
  // degree = 1 px; cardinals are labelled every 45° and tick marks every 10°.
  function drawCompass(bearing) {
    if (!compassCtx) return;
    const W = _cW, H = _cH;
    const cx = W / 2;
    compassCtx.clearRect(0, 0, W, H);

    // Semi-transparent pill background.
    const bgR = compassCtx.createLinearGradient(0, 0, 0, H);
    bgR.addColorStop(0,   'rgba(10,12,24,0.55)');
    bgR.addColorStop(1,   'rgba(10,12,24,0.30)');
    compassCtx.fillStyle = bgR;
    // Flush (mobile): edge-to-edge bar. Desktop: full-WIDTH band inset only top/
    // bottom (PY). Full width matters so the horizontal edge-fade below reaches a
    // true 0 right at the canvas edge — an inset pill would leave a hard vertical
    // border the canvas-relative gradient can't fully erase. Ticks still use PX.
    const PX = _cFlush ? 0 : 18, PY = _cFlush ? 0 : 6;
    compassCtx.beginPath();
    compassCtx.roundRect(0, PY, W, H - PY * 2, _cFlush ? 0 : 6);
    compassCtx.fill();

    // Desktop: fade the grey background out to 0 opacity at the left/right edges.
    // destination-in multiplies existing alpha by this horizontal mask — and since
    // only the background has been drawn so far, the ticks/labels (drawn next) are
    // untouched. Solid through the middle, then ease to transparent across the
    // outer 15% on each side, hitting exactly 0 at the edge so no edge is visible.
    if (!_cFlush) {
      const edge = compassCtx.createLinearGradient(0, 0, W, 0);
      edge.addColorStop(0.00, 'rgba(0,0,0,0)');
      edge.addColorStop(0.15, 'rgba(0,0,0,1)');
      edge.addColorStop(0.85, 'rgba(0,0,0,1)');
      edge.addColorStop(1.00, 'rgba(0,0,0,0)');
      compassCtx.save();
      compassCtx.globalCompositeOperation = 'destination-in';
      compassCtx.fillStyle = edge;
      compassCtx.fillRect(0, 0, W, H);
      compassCtx.restore();
    }

    // Cardinal labels and tick marks. Iterate over the MARK degrees themselves
    // (every 10°) and place each at its signed offset from the current heading,
    // so the tape scrolls smoothly — testing pixel offsets for divisibility fails
    // because `bearing` is fractional and never lands exactly on a multiple.
    const CARDS = { 0:'N', 45:'NE', 90:'E', 135:'SE', 180:'S', 225:'SW', 270:'W', 315:'NW' };
    compassCtx.save();
    compassCtx.beginPath();
    compassCtx.rect(PX, 0, W - PX * 2, H);
    compassCtx.clip();

    for (let deg = 0; deg < 360; deg += 10) {
      // Signed shortest angular difference from the heading → pixel offset (1°/px).
      let diff = deg - bearing;
      diff = ((diff + 180) % 360 + 360) % 360 - 180;
      const x = cx + diff;
      if (x < PX || x > W - PX) continue;

      const isMaj = deg % 45 === 0;
      const tickH = isMaj ? 10 : 6;
      compassCtx.strokeStyle = isMaj ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.40)';
      compassCtx.lineWidth   = isMaj ? 1.5 : 1;
      compassCtx.beginPath();
      compassCtx.moveTo(x, H - PY - tickH);
      compassCtx.lineTo(x, H - PY);
      compassCtx.stroke();

      const label = CARDS[deg];
      if (label) {
        const isCard = deg % 90 === 0;
        compassCtx.fillStyle = isCard ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.60)';
        compassCtx.font = `${isCard ? 600 : 400} ${isCard ? 11 : 10}px system-ui,sans-serif`;
        compassCtx.textAlign = 'center';
        compassCtx.textBaseline = 'bottom';
        compassCtx.fillText(label, x, H - PY - tickH - 3);
      }
    }
    compassCtx.restore();

    // Centre marker triangle pointing down at the current heading.
    compassCtx.fillStyle = 'rgba(255,220,60,0.95)';
    compassCtx.beginPath();
    compassCtx.moveTo(cx,     PY + 2);
    compassCtx.lineTo(cx - 5, PY + 10);
    compassCtx.lineTo(cx + 5, PY + 10);
    compassCtx.closePath();
    compassCtx.fill();

    // Current bearing readout below the triangle.
    compassCtx.fillStyle = 'rgba(255,255,255,0.90)';
    compassCtx.font = '600 10px system-ui,sans-serif';
    compassCtx.textAlign = 'center';
    compassCtx.textBaseline = 'top';
    compassCtx.fillText(Math.round(bearing) + '°', cx, PY + 12);
  }

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

  // Backtick (`) toggles fisheye + closer follow camera.
  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === 'Backquote') {
      e.preventDefault();
      fisheyeActive = !fisheyeActive;
      FISH_U.uFishOn.value = fisheyeActive ? 1 : 0;
      if (fisheyeActive) fishCullEnter(); else fishCullExit();
      controls.setFisheye(fisheyeActive);
    }
  });

  // F1 = pause everything and show the hotkey menu (a 40% white wash over the
  // whole screen). While paused the animate loop skips all motion/animation
  // updates and just re-renders the frozen frame. F1 or Esc closes it.
  const _helpTouch = (window.matchMedia && matchMedia('(pointer: coarse)').matches)
                  || ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
  let paused = false;
  const helpEl = document.getElementById('help');
  function setPaused(p) {
    paused = p;
    if (helpEl) helpEl.classList.toggle('hidden', !p);
  }
  // Freeze motion WITHOUT showing the F1 help overlay — used by quiz mode, which
  // brings up its own panel and must not flash the controls menu underneath.
  function setFrozen(p) { paused = p; }
  // Clicking the backdrop (anywhere outside the panel) closes the menu.
  if (helpEl) helpEl.addEventListener('click', e => {
    if (e.target === helpEl) setPaused(false);
  });
  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === 'F1') { e.preventDefault(); setPaused(!paused); }
    else if (e.code === 'Escape' && paused) { e.preventDefault(); setPaused(false); }
    else if (e.code === 'KeyF') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => {});
    }
  });

  // Character animation (wing flap, tail flutter) lives in the character
  // controller; main.js just positions the group each frame (below).
  let activeCharId   = DEFAULT_CHARACTER;
  let charController = character.createController(birdMesh);

  // Swap to a different character at runtime (F2 = bird, F3 = girl).
  function switchCharacter(id) {
    if (id === activeCharId || !CHARACTERS[id]) return;
    scene.remove(birdMesh);
    birdMesh = CHARACTERS[id].build(applyFisheye);
    birdMesh.position.copy(controls.birdPos);
    scene.add(birdMesh);
    charController = CHARACTERS[id].createController(birdMesh);
    activeCharId = id;
  }

  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === 'F2') { e.preventDefault(); switchCharacter('bird'); }
    if (e.code === 'F3') { e.preventDefault(); switchCharacter('girl'); }
  });

  (function animate() {
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt  = Math.min((now - lastTime) / 1000, 0.1);
    lastTime  = now;
    // Paused (F1 menu open): freeze all motion/animation, just re-render.
    if (paused) { renderer.render(scene, camera); return; }
    controls.update();
    if (speedEl && dt > 0) {
      const kmh = (controls.getSpeed() / dt * 3.6).toFixed(0);
      speedEl.textContent = kmh + ' km/h';
    }
    // Bird heading vector is (-sinθ,0,-cosθ) for yaw θ; with +X=East and -Z=North
    // the true clockwise-from-North bearing is -θ, so negate getYaw() here.
    drawCompass(((-controls.getYaw() * 180 / Math.PI) % 360 + 360) % 360);
    updateAreaName(controls.birdPos.x, controls.birdPos.z);
    if (mapsLinkEl) {
      const { lat: _ml, lon: _mo } = worldToGeo(controls.birdPos.x, controls.birdPos.z);
      mapsLinkEl.href = `https://www.google.com/maps/@${_ml.toFixed(6)},${_mo.toFixed(6)},17z`;
    }
    // Sync bird mesh: position + flight orientation (yaw, nose pitch, bank roll)
    birdMesh.position.copy(controls.birdPos);
    birdMesh.position.y += 0.1 * Math.sin(now * 0.002);   // gentle float bob
    birdMesh.rotation.set(controls.getPitch(), controls.getYaw(), controls.getRoll(), 'YXZ');

    // ── Wing flap ──────────────────────────────────────────────────────────
    // Occasional flapping bursts when cruising; while diving the wings stop
    // flapping and raise into a swept-back V, slanted up to 45° in proportion
    // to how steep the dive is (nose-down pitch from ~11° toward vertical).
    charController.update(dt, now, { pitch: controls.getPitch(), speed: controls.getSpeed() });
    if (trainRef.system) trainRef.system.update(dt);
    // Declutter: only keep labels near the camera visible. Labels stay on even
    // under the speed warp (the user toggles them on deliberately) — they're
    // camera-facing billboards, so they ride along near their world anchor.
    const cp = camera.position;
    for (const grp of [labelsRef.bldgGroup, labelsRef.poiGroup]) {
      if (grp && grp.visible) {
        for (const s of grp.children) s.visible = cp.distanceTo(s.position) < LABEL_DIST;
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

  return { scene, camera, controls, trainRef, labelsRef, ground, renderer,
           setPaused, setFrozen, isPaused: () => paused, isTouch: _helpTouch };
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

// A curated list of major world cities with coordinates baked in, so the dice
// and quiz buttons can jump to a big city instantly — no geocoding, no LLM.
// Coords point at each city's dense core. [name, lat, lon, country].
const MAJOR_CITIES = [
  ['Tokyo', 35.6762, 139.6503, 'Japan'], ['Delhi', 28.6139, 77.2090, 'India'],
  ['Shanghai', 31.2304, 121.4737, 'China'], ['São Paulo', -23.5505, -46.6333, 'Brazil'],
  ['Mexico City', 19.4326, -99.1332, 'Mexico'], ['Cairo', 30.0444, 31.2357, 'Egypt'],
  ['Mumbai', 19.0760, 72.8777, 'India'], ['Beijing', 39.9042, 116.4074, 'China'],
  ['Dhaka', 23.8103, 90.4125, 'Bangladesh'], ['Osaka', 34.6937, 135.5023, 'Japan'],
  ['New York', 40.7128, -74.0060, 'USA'], ['Karachi', 24.8607, 67.0011, 'Pakistan'],
  ['Buenos Aires', -34.6037, -58.3816, 'Argentina'], ['Chongqing', 29.4316, 106.9123, 'China'],
  ['Istanbul', 41.0082, 28.9784, 'Turkey'], ['Kolkata', 22.5726, 88.3639, 'India'],
  ['Manila', 14.5995, 120.9842, 'Philippines'], ['Lagos', 6.5244, 3.3792, 'Nigeria'],
  ['Rio de Janeiro', -22.9068, -43.1729, 'Brazil'], ['Guangzhou', 23.1291, 113.2644, 'China'],
  ['Los Angeles', 34.0522, -118.2437, 'USA'], ['Moscow', 55.7558, 37.6173, 'Russia'],
  ['Shenzhen', 22.5431, 114.0579, 'China'], ['Lahore', 31.5204, 74.3587, 'Pakistan'],
  ['Bangalore', 12.9716, 77.5946, 'India'], ['Paris', 48.8566, 2.3522, 'France'],
  ['Bogotá', 4.7110, -74.0721, 'Colombia'], ['Jakarta', -6.2088, 106.8456, 'Indonesia'],
  ['Chennai', 13.0827, 80.2707, 'India'], ['Lima', -12.1464, -77.0428, 'Peru'],
  ['Bangkok', 13.7563, 100.5018, 'Thailand'], ['Seoul', 37.5665, 126.9780, 'South Korea'],
  ['Nagoya', 35.1815, 136.9066, 'Japan'], ['Hyderabad', 17.3850, 78.4867, 'India'],
  ['London', 51.5074, -0.1278, 'UK'], ['Tehran', 35.6892, 51.3890, 'Iran'],
  ['Chicago', 41.8781, -87.6298, 'USA'], ['Chengdu', 30.5728, 104.0668, 'China'],
  ['Nanjing', 32.0603, 118.7969, 'China'], ['Wuhan', 30.5928, 114.3055, 'China'],
  ['Ho Chi Minh City', 10.8231, 106.6297, 'Vietnam'], ['Luanda', -8.8390, 13.2894, 'Angola'],
  ['Ahmedabad', 23.0225, 72.5714, 'India'], ['Kuala Lumpur', 3.1390, 101.6869, 'Malaysia'],
  ['Xi’an', 34.3416, 108.9398, 'China'], ['Hong Kong', 22.3193, 114.1694, 'China'],
  ['Dongguan', 23.0207, 113.7518, 'China'], ['Hangzhou', 30.2741, 120.1551, 'China'],
  ['Foshan', 23.0218, 113.1064, 'China'], ['Riyadh', 24.7136, 46.6753, 'Saudi Arabia'],
  ['Baghdad', 33.3152, 44.3661, 'Iraq'], ['Santiago', -33.4489, -70.6693, 'Chile'],
  ['Surat', 21.1702, 72.8311, 'India'], ['Madrid', 40.4168, -3.7038, 'Spain'],
  ['Suzhou', 31.2989, 120.5853, 'China'], ['Pune', 18.5204, 73.8567, 'India'],
  ['Harbin', 45.8038, 126.5350, 'China'], ['Houston', 29.7604, -95.3698, 'USA'],
  ['Dallas', 32.7767, -96.7970, 'USA'], ['Toronto', 43.6532, -79.3832, 'Canada'],
  ['Dar es Salaam', -6.7924, 39.2083, 'Tanzania'], ['Miami', 25.7617, -80.1918, 'USA'],
  ['Belo Horizonte', -19.9167, -43.9345, 'Brazil'], ['Singapore', 1.3521, 103.8198, 'Singapore'],
  ['Philadelphia', 39.9526, -75.1652, 'USA'], ['Atlanta', 33.7490, -84.3880, 'USA'],
  ['Fukuoka', 33.5904, 130.4017, 'Japan'], ['Khartoum', 15.5007, 32.5599, 'Sudan'],
  ['Barcelona', 41.3851, 2.1734, 'Spain'], ['Johannesburg', -26.2041, 28.0473, 'South Africa'],
  ['Saint Petersburg', 59.9311, 30.3609, 'Russia'], ['Qingdao', 36.0671, 120.3826, 'China'],
  ['Dalian', 38.9140, 121.6147, 'China'], ['Washington', 38.9072, -77.0369, 'USA'],
  ['Yangon', 16.8409, 96.1735, 'Myanmar'], ['Alexandria', 31.2001, 29.9187, 'Egypt'],
  ['Jinan', 36.6512, 117.1201, 'China'], ['Guadalajara', 20.6597, -103.3496, 'Mexico'],
  ['Boston', 42.3601, -71.0589, 'USA'], ['Abidjan', 5.3600, -4.0083, 'Ivory Coast'],
  ['Ankara', 39.9334, 32.8597, 'Turkey'], ['Phoenix', 33.4484, -112.1440, 'USA'],
  ['San Francisco', 37.7749, -122.4194, 'USA'], ['Berlin', 52.5200, 13.4050, 'Germany'],
  ['Sydney', -33.8688, 151.2093, 'Australia'], ['Melbourne', -37.8136, 144.9631, 'Australia'],
  ['Casablanca', 33.5731, -7.5898, 'Morocco'], ['Montréal', 45.5017, -73.5673, 'Canada'],
  ['Nairobi', -1.2864, 36.8172, 'Kenya'], ['Cape Town', -33.9249, 18.4241, 'South Africa'],
  ['Rome', 41.9028, 12.4964, 'Italy'], ['Caracas', 10.4806, -66.9036, 'Venezuela'],
  ['Addis Ababa', 9.0250, 38.7469, 'Ethiopia'], ['Detroit', 42.3314, -83.0458, 'USA'],
  ['Seattle', 47.6062, -122.3321, 'USA'], ['Kabul', 34.5553, 69.2075, 'Afghanistan'],
  ['Pyongyang', 39.0392, 125.7625, 'North Korea'], ['Accra', 5.6037, -0.1870, 'Ghana'],
  ['Kano', 12.0322, 8.5920, 'Nigeria'], ['Taipei', 25.0330, 121.5654, 'Taiwan'],
  ['Kyiv', 50.4501, 30.5234, 'Ukraine'], ['Guayaquil', -2.1709, -79.9224, 'Ecuador'],
  ['Hanoi', 21.0285, 105.8542, 'Vietnam'], ['Medellín', 6.2476, -75.5658, 'Colombia'],
  ['Minneapolis', 44.9778, -93.2650, 'USA'], ['San Diego', 32.7157, -117.1611, 'USA'],
  ['Amman', 31.9454, 35.9284, 'Jordan'], ['Frankfurt', 50.1109, 8.6821, 'Germany'],
  ['Vienna', 48.2082, 16.3738, 'Austria'], ['Hamburg', 53.5511, 9.9937, 'Germany'],
  ['Munich', 48.1351, 11.5820, 'Germany'], ['Milan', 45.4642, 9.1900, 'Italy'],
  ['Athens', 37.9838, 23.7275, 'Greece'], ['Warsaw', 52.2297, 21.0122, 'Poland'],
  ['Bucharest', 44.4268, 26.1025, 'Romania'], ['Budapest', 47.4979, 19.0402, 'Hungary'],
  ['Amsterdam', 52.3676, 4.9041, 'Netherlands'], ['Brussels', 50.8503, 4.3517, 'Belgium'],
  ['Lisbon', 38.7223, -9.1393, 'Portugal'], ['Stockholm', 59.3293, 18.0686, 'Sweden'],
  ['Copenhagen', 55.6761, 12.5683, 'Denmark'], ['Prague', 50.0755, 14.4378, 'Czechia'],
  ['Dubai', 25.2048, 55.2708, 'UAE'], ['Abu Dhabi', 24.4539, 54.3773, 'UAE'],
  ['Doha', 25.2854, 51.5310, 'Qatar'], ['Kuwait City', 29.3759, 47.9774, 'Kuwait'],
  ['Tel Aviv', 32.0853, 34.7818, 'Israel'], ['Jeddah', 21.4858, 39.1925, 'Saudi Arabia'],
  ['Auckland', -36.8485, 174.7633, 'New Zealand'], ['Brisbane', -27.4698, 153.0251, 'Australia'],
  ['Perth', -31.9523, 115.8613, 'Australia'], ['Vancouver', 49.2827, -123.1207, 'Canada'],
  ['Las Vegas', 36.1699, -115.1398, 'USA'], ['Denver', 39.7392, -104.9903, 'USA'],
  ['Tashkent', 41.2995, 69.2401, 'Uzbekistan'], ['Baku', 40.4093, 49.8671, 'Azerbaijan'],
  ['Almaty', 43.2220, 76.8512, 'Kazakhstan'], ['Minsk', 53.9006, 27.5590, 'Belarus'],
  ['Dublin', 53.3498, -6.2603, 'Ireland'], ['Helsinki', 60.1699, 24.9384, 'Finland'],
  ['Oslo', 59.9139, 10.7522, 'Norway'], ['Zürich', 47.3769, 8.5417, 'Switzerland'],
  ['Naples', 40.8518, 14.2681, 'Italy'], ['Marseille', 43.2965, 5.3698, 'France'],
  ['Lyon', 45.7640, 4.8357, 'France'], ['Porto', 41.1579, -8.6291, 'Portugal'],
  ['Tunis', 36.8065, 10.1815, 'Tunisia'], ['Algiers', 36.7538, 3.0588, 'Algeria'],
  ['Tripoli', 32.8872, 13.1913, 'Libya'], ['Beirut', 33.8938, 35.5018, 'Lebanon'],
  ['Damascus', 33.5138, 36.2765, 'Syria'], ['Quito', -0.1807, -78.4678, 'Ecuador'],
  ['Montevideo', -34.9011, -56.1645, 'Uruguay'], ['Asunción', -25.2637, -57.5759, 'Paraguay'],
  ['La Paz', -16.4897, -68.1193, 'Bolivia'], ['Brasília', -15.7975, -47.8919, 'Brazil'],
  ['Salvador', -12.9777, -38.5016, 'Brazil'], ['Fortaleza', -3.7319, -38.5267, 'Brazil'],
  ['Recife', -8.0476, -34.8770, 'Brazil'], ['Curitiba', -25.4284, -49.2733, 'Brazil'],
  ['Panama City', 8.9824, -79.5199, 'Panama'], ['San José', 9.9281, -84.0907, 'Costa Rica'],
  ['Havana', 23.1136, -82.3666, 'Cuba'], ['Santo Domingo', 18.4861, -69.9312, 'Dominican Republic'],
  ['Guatemala City', 14.6349, -90.5069, 'Guatemala'], ['Maputo', -25.9692, 32.5732, 'Mozambique'],
  ['Kinshasa', -4.4419, 15.2663, 'DR Congo'], ['Dakar', 14.7167, -17.4677, 'Senegal'],
  ['Kampala', 0.3476, 32.5825, 'Uganda'], ['Lusaka', -15.3875, 28.3228, 'Zambia'],
  ['Harare', -17.8252, 31.0335, 'Zimbabwe'], ['Mombasa', -4.0435, 39.6682, 'Kenya'],
];

// Build one quiz round: a random answer city plus two distinct decoys, with the
// three names shuffled. Returns a promptLocation-style result tagged quiz:true.
function makeQuizCity() {
  const pick = () => MAJOR_CITIES[(Math.random() * MAJOR_CITIES.length) | 0];
  const fmt  = c => `${c[0]}, ${c[3]}`;                  // "City, Country"
  const ans = pick();
  const wrong = [];
  while (wrong.length < 2) {
    const c = pick();
    if (c[0] !== ans[0] && !wrong.some(w => w[0] === c[0])) wrong.push(c);
  }
  const options = [fmt(ans), fmt(wrong[0]), fmt(wrong[1])];
  for (let i = options.length - 1; i > 0; i--) {        // Fisher–Yates shuffle
    const j = (Math.random() * (i + 1)) | 0;
    [options[i], options[j]] = [options[j], options[i]];
  }
  return { lat: ans[1], lon: ans[2], label: ans[0], shortLabel: ans[0],
           quiz: true, answer: fmt(ans), options };
}

// Shows the search field on the loading screen and resolves once the user picks a
// place that geocodes successfully. Returns { lat, lon, label, shortLabel }.
function promptLocation() {
  return new Promise(resolve => {
    // "Play again" reloads the page (staying on the root URL) and leaves a
    // one-shot sessionStorage flag so this load auto-starts a fresh quiz round
    // and skips the menu entirely.
    if (sessionStorage.getItem('quiz') === '1') {
      sessionStorage.removeItem('quiz');
      const lt = document.getElementById('load-title');
      for (const id of ['load-search', 'place-me', 'load-extra']) {
        const el = document.getElementById(id);
        if (el) el.style.display = 'none';
      }
      if (lt) lt.textContent = 'Quiz';
      resolve(makeQuizCity());
      return;
    }

    const input = document.getElementById('place-input');
    const btn   = document.getElementById('place-go');
    const meBtn = document.getElementById('place-me');
    const rndBtn = document.getElementById('place-random');
    const quizBtn = document.getElementById('place-quiz');
    const msg   = document.getElementById('search-msg');
    input.focus();
    input.select();

    const lock   = () => { btn.disabled = input.disabled = meBtn.disabled = rndBtn.disabled = quizBtn.disabled = true; };
    const unlock = () => { btn.disabled = input.disabled = meBtn.disabled = rndBtn.disabled = quizBtn.disabled = false; };

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

    // Surprise me — jump straight to a random major city. Coords are baked in,
    // so this resolves instantly with no network round-trip.
    function randomCity() {
      const [name, lat, lon] = MAJOR_CITIES[(Math.random() * MAJOR_CITIES.length) | 0];
      lock();
      msg.textContent = `Flying to ${name}…`;
      resolve({ lat, lon, label: name, shortLabel: name });
    }

    // Quiz me — drop into a random city with its name hidden and guess where.
    function startQuiz() {
      lock();
      msg.textContent = 'Starting quiz…';
      resolve(makeQuizCity());
    }

    btn.addEventListener('click', go);
    meBtn.addEventListener('click', useMyLocation);
    rndBtn.addEventListener('click', randomCity);
    quizBtn.addEventListener('click', startQuiz);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  });
}

function setPlaceLabel(name) {
  document.title = `${name} · 3D`;
  const lt   = document.getElementById('load-title');
  const span = document.getElementById('place-name');
  if (lt)   lt.textContent   = name;
  if (span) span.textContent = name;
}

// Per-tile area names. Each tile (the same ~550 m grid the city geometry
// streams in) gets reverse-geocoded once; the result is cached by tile key so
// re-entering a known tile switches the label INSTANTLY with no network call.
// The label updates the moment you cross a tile boundary, not on a timer.
const NAME_PREFETCH = 1;        // also fetch names for tiles within this ring radius
const _tileNames = new Map();   // tileKey → name string ('' = looked up, none found)
let   _rgTileKey = null;        // tile the label currently reflects
const _rgQueue   = [];          // pending tile lookups: { tx, ty, key, isCurrent }
const _rgQueued  = new Set();   // keys already cached or queued (avoid duplicates)
let   _rgBusy    = false;       // a lookup is in flight / the drain loop is running
let   _rgStarted = false;       // true once a start location is chosen (gates lookups)

// The world is centred on the start location, so its tile is the tile of
// CENTER_LAT/LON. Cache the user's chosen name there so the label doesn't get
// reverse-geocoded away the moment the flight begins.
function seedStartTile(name) {
  const { tx, ty } = latLonToTile(CENTER_LAT, CENTER_LON);
  const key = `${tx},${ty}`;
  _tileNames.set(key, name);
  _rgQueued.add(key);
  _rgTileKey = key;
  _rgStarted = true;            // the animate loop may now update the area label
}

// Parse a Nominatim /reverse response into a 'City · Suburb' style label.
function _formatArea(d) {
  const a = d.address || {};
  const big   = a.city || a.town || a.village || a.county || '';
  const small = a.suburb || a.neighbourhood || a.quarter || a.city_district || '';
  return big && small ? `${big} · ${small}` : big || small
       || (d.display_name || '').split(',')[0] || '';
}

// Drain the lookup queue one request at a time, ≥ 1.2 s apart (Nominatim asks
// for ≤ 1 req/s). Current-tile lookups are unshifted to the front so the label
// updates promptly while neighbour prefetches fill in behind it.
async function _rgDrain() {
  if (_rgBusy) return;
  _rgBusy = true;
  while (_rgQueue.length) {
    const job = _rgQueue.shift();
    const bbox = tileToBBox(job.tx, job.ty);
    const clat = ((bbox.south + bbox.north) / 2).toFixed(5);
    const clon = ((bbox.west  + bbox.east)  / 2).toFixed(5);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${clat}&lon=${clon}`,
        { headers: { 'Accept': 'application/json' } });
      const name = _formatArea(await res.json());
      _tileNames.set(job.key, name);
      // Only update the visible label if this tile is still the one we're over.
      if (job.key === _rgTileKey && name) setPlaceLabel(name);
    } catch (_) {
      // Network/parse failure: let it be retried by re-opening the key.
      _rgQueued.delete(job.key);
    }
    if (_rgQueue.length) await sleep(1200);
  }
  _rgBusy = false;
}

function _rgEnqueue(tx, ty, isCurrent) {
  const key = `${tx},${ty}`;
  if (_rgQueued.has(key)) return;
  _rgQueued.add(key);
  const job = { tx, ty, key, isCurrent };
  if (isCurrent) _rgQueue.unshift(job);   // jump the queue so the label updates first
  else           _rgQueue.push(job);
  _rgDrain();
}

function updateAreaName(worldX, worldZ) {
  if (!_rgStarted) return;   // don't geocode (or clobber "Where to?") before a start is chosen
  const { lat, lon } = worldToGeo(worldX, worldZ);
  const { tx, ty } = latLonToTile(lat, lon);
  const key = `${tx},${ty}`;
  if (key === _rgTileKey) return;            // same tile → nothing to do
  _rgTileKey = key;

  // Known tile: switch the label instantly from cache, no network.
  if (_tileNames.has(key)) {
    const name = _tileNames.get(key);
    if (name) setPlaceLabel(name);
  } else {
    _rgEnqueue(tx, ty, true);                // priority lookup for the tile we're over
  }

  // Prefetch names for the ring of tiles around us so the NEXT boundary cross
  // is instant. These go to the back of the queue behind the current tile.
  for (let dy = -NAME_PREFETCH; dy <= NAME_PREFETCH; dy++)
    for (let dx = -NAME_PREFETCH; dx <= NAME_PREFETCH; dx++)
      if (dx || dy) _rgEnqueue(tx + dx, ty + dy, false);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const loadMsg  = document.getElementById('load-msg');
  const statusEl = document.getElementById('status');

  pruneCache();   // drop expired Overpass entries (3-day TTL) in the background

  // Mutable ref so controls (created first) can call collision once tiles arrive
  const collision = { fn: null };
  const { scene, camera, controls, trainRef, labelsRef, ground, renderer,
          setPaused, setFrozen, isPaused, isTouch } = initScene(collision);

  // Ask where to start, geocode it, then center the world there.
  const place = await promptLocation();
  const quizActive = !!place.quiz;
  setCenter(place.lat, place.lon);
  if (quizActive) {
    // Quiz: keep the city anonymous — no start label, and skip seedStartTile so
    // _rgStarted stays false and the animate loop never reverse-geocodes an area
    // name. The countdown stands in for the location until "Explore more".
    document.body.classList.add('quiz-mode');
    const lt = document.getElementById('load-title');
    if (lt) lt.textContent = 'Quiz';
  } else {
    setPlaceLabel(place.shortLabel);
    seedStartTile(place.shortLabel);   // pin the chosen name to the start tile
  }

  // Switch the loading screen from search mode to progress mode.
  document.getElementById('load-search').style.display = 'none';
  document.getElementById('place-me').style.display    = 'none';
  document.getElementById('load-extra').style.display  = 'none';
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

  // 1 = hide all HUD chrome, 2 = building names, 3 = POI labels.
  labelsRef.bldgGroup = manager.buildingLabelGroup;
  labelsRef.poiGroup  = manager.poiLabelGroup;
  window.addEventListener('keydown', e => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.code === 'Digit1') {
      e.preventDefault();
      document.body.classList.toggle('ui-hidden');
    }
    // Names would give the quiz away — ignore the label toggles until the round
    // is over (the quiz-mode class is dropped when the player picks Explore more).
    if (e.code === 'Digit2' && !document.body.classList.contains('quiz-mode')) {
      e.preventDefault();
      manager.buildingLabelGroup.visible = !manager.buildingLabelGroup.visible;
    }
    if (e.code === 'Digit3' && !document.body.classList.contains('quiz-mode')) {
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
    setTimeout(() => {
      loading.remove();
      // Desktop: open the controls menu on first load — but not in a quiz, where
      // the quiz panel takes over instead.
      if (!isTouch && !quizActive) setPaused(true);
    }, 800);
    syncTrains();
  }

  // ── Quiz round ─────────────────────────────────────────────────────────────
  // Drives the whole flow: explore immediately for 20 s with the question + three
  // choices floating in the sky (the last 2 s wash to white) → guess in a panel →
  // result → play again / explore more. World motion is live while exploring and
  // frozen only for the guess/result panel.
  function startQuizGame(answer, options) {
    const quizEl    = document.getElementById('quiz');
    const optionsEl = document.getElementById('quiz-options');
    const actionsEl = document.getElementById('quiz-actions');
    const resultEl  = document.getElementById('quiz-result');
    const fadeEl    = document.getElementById('quiz-fade');
    const timerEl   = document.getElementById('quiz-timer');
    const skyEl     = document.getElementById('quiz-sky');
    const qEl       = document.getElementById('quiz-q');
    const EXPLORE_SECONDS = 20, FADE_AT = 16;
    let selected = null, exploring = false, elapsed = 0, lastT = 0, moving = false;

    const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); };
    const show  = on => quizEl.classList.toggle('hidden', !on);
    const mkBtn = (label, primary) => {
      const b = document.createElement('button');
      b.className = 'quiz-btn' + (primary ? '' : ' ghost');
      b.textContent = label;
      return b;
    };

    function renderOptions(clickable) {
      clear(optionsEl);
      selected = null;
      for (const name of options) {
        const b = document.createElement('button');
        b.className = 'quiz-opt';
        b.textContent = name;
        b.disabled = !clickable;
        if (clickable) b.addEventListener('click', () => {
          selected = name;
          for (const c of optionsEl.children) c.classList.toggle('selected', c === b);
          const sub = document.getElementById('quiz-submit');
          if (sub) sub.disabled = false;
        });
        optionsEl.appendChild(b);
      }
    }

    // The question + choices live in a screen-space overlay (#quiz-sky), centered
    // horizontally in the browser and a fixed pixel size — so neither flying nor
    // looking around changes its size or horizontal placement. It's a plain list
    // (no buttons) since you're not picking yet; the body.quiz-exploring class
    // controls its visibility.
    function renderSky() {
      clear(skyEl);
      skyEl.appendChild(timerEl);     // big countdown stays pinned on top
      const q = document.createElement('div');
      q.className = 'quiz-sky-q';
      q.textContent = 'Where am I?';
      skyEl.appendChild(q);
      for (const name of options) {
        const o = document.createElement('div');
        o.className = 'quiz-sky-opt';
        o.textContent = name;
        skyEl.appendChild(o);
      }
    }

    function clearSky() { clear(skyEl); }

    // 1) Explore — starts immediately: world live, countdown running, the choices
    //    floating in the sky. The final 2 s wash to white.
    function startExplore() {
      resultEl.textContent = ''; resultEl.className = '';
      fadeEl.style.opacity = '0';
      renderSky();
      show(false);
      setFrozen(false);
      elapsed = 0; lastT = performance.now(); exploring = true; moving = false;
      timerEl.textContent = EXPLORE_SECONDS;   // park the clock at 20 until liftoff
      document.body.classList.add('quiz-exploring');
      requestAnimationFrame(tick);
    }
    function tick() {
      if (!exploring) return;
      const now = performance.now();
      const dt = (now - lastT) / 1000; lastT = now;
      // The countdown is armed by flight, not by looking around: hold at 20 until
      // the bird first actually moves (velocity > 0 from thrust), then it ticks.
      if (!moving && controls.getSpeed() > 0.01) moving = true;
      if (moving && !isPaused()) elapsed += dt;   // don't count time spent in the F1 menu
      const left = Math.max(0, EXPLORE_SECONDS - elapsed);
      timerEl.textContent = Math.ceil(left);
      // Ease-in the white wash: linear progress through the fade window, then
      // raised to a power so it starts gently and accelerates toward 20 s.
      const fadeT = Math.max(0, Math.min(1, (elapsed - FADE_AT) / (EXPLORE_SECONDS - FADE_AT)));
      fadeEl.style.opacity = String(fadeT * fadeT * fadeT);
      if (left <= 0) { endExplore(); return; }
      requestAnimationFrame(tick);
    }

    // 3) Guess — freeze, bring the panel back with the now-selectable choices.
    function endExplore() {
      exploring = false;
      document.body.classList.remove('quiz-exploring');
      clearSky();
      setFrozen(true);
      // Free the mouse so the player can click an option (flight locks it).
      if (document.exitPointerLock) document.exitPointerLock();
      qEl.textContent = 'Where were you?';
      renderOptions(true);
      clear(actionsEl);
      const submit = mkBtn('Submit', true);
      submit.id = 'quiz-submit';
      submit.disabled = true;
      submit.addEventListener('click', showResult);
      actionsEl.appendChild(submit);
      show(true);
      fadeEl.style.opacity = '1';   // hold the view fully white through the guess
    }

    // 4) Result — mark right/wrong, offer play again or free exploration.
    function showResult() {
      const correct = selected === answer;
      for (const c of optionsEl.children) {
        c.disabled = true;
        if (c.textContent === answer)        c.classList.add('right');
        else if (c.textContent === selected) c.classList.add('wrong');
      }
      resultEl.className = correct ? 'correct' : 'wrong';
      resultEl.textContent = correct
        ? `Correct! You were in ${answer}.`
        : `Not quite — you were in ${answer}.`;
      clear(actionsEl);
      const again = mkBtn('Play again', true);
      again.addEventListener('click', () => { sessionStorage.setItem('quiz', '1'); location.reload(); });
      const more  = mkBtn('Explore more', false);
      more.addEventListener('click', exploreMore);
      actionsEl.appendChild(again);
      actionsEl.appendChild(more);
    }

    // 5) Explore more — drop the quiz veil, reveal the city, free flight.
    function exploreMore() {
      clearSky();
      show(false);
      fadeEl.style.opacity = '0';   // lift the white veil to reveal the city
      document.body.classList.remove('quiz-mode');
      timerEl.textContent = '';
      setPlaceLabel(answer);
      seedStartTile(answer);   // _rgStarted → area-name labels resume
      setFrozen(false);
    }

    startExplore();
  }

  // One Overpass request covers the whole load region. (Previously a second
  // inner "core" query ran alongside this one; its bbox sits entirely inside the
  // region, so it re-downloaded the centre and competed with this query for
  // Overpass's per-IP concurrency slots. Fetching once is faster and lighter —
  // and terrain still loads in parallel so neither waits on the other.)
  const region = manager.regionTiles(0, 0, LOAD_RADIUS);
  manager.tilesTotal = region.keys.length;

  setLoad('Loading terrain & map data…', 0.2);
  const [terrainResult, regionOsm] = await Promise.all([
    loadTerrain(),
    manager._fetchWithRetry(region.bbox, 'region', setLoad),
  ]);

  terrain = terrainResult;
  if (terrain) {
    // Displace ground plane vertices. PlaneGeometry is in XY before rotation.x = -π/2,
    // which maps local (x, y, z) → world (x, z, -y). To set world Y, set local Z.
    const pos  = ground.geometry.attributes.position;
    const elev = ground.geometry.attributes.aElev;
    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i), wz = -pos.getY(i);
      pos.setZ(i, terrain.sample(wx, wz) - GROUND_SINK);
      elev.setX(i, terrain.sampleAbs(wx, wz));   // absolute m above sea level
    }
    pos.needsUpdate  = true;
    elev.needsUpdate = true;
    ground.geometry.computeVertexNormals();
    ground.material.uniforms.uSeaOn.value = 1.0;   // terrain is in → enable the sea
    controls.init(0, terrain.sample(0, 0) + BIRD_HEIGHT, 0);
  }

  // Build the whole region synchronously while still behind the loading screen
  // so no geometry build ever runs after reveal (no post-reveal hitch).
  if (regionOsm) { setLoad('Building the city…', 0.88); await sleep(0); }
  manager._settleRegion(region.keys, regionOsm);
  syncTrains();

  // Warm-up: compile all shaders and force GPU buffer uploads before the
  // overlay lifts so the bird is genuinely movable the instant it appears.
  setLoad('Warming up…', 0.97);
  renderer.compile(scene, camera);
  for (let i = 0; i < 2; i++) await nextFrame();

  reveal();
  if (quizActive) startQuizGame(place.answer, place.options);
  // Background: only POIs remain (off by default; F2 to show).
  manager.loadPOIs(region.bbox);
}

main();
