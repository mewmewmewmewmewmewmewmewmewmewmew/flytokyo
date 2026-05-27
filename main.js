import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import earcut from 'earcut';

// ─── Config ──────────────────────────────────────────────────────────────────

const CENTER_LAT = 35.6595;   // Shibuya Scramble Crossing
const CENTER_LON = 139.7004;

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos(CENTER_LAT * Math.PI / 180);

const TILE_LAT    = 0.005;   // ≈ 556 m per tile
const TILE_LON    = 0.006;   // ≈ 540 m per tile
const LOAD_RADIUS = 1;       // tiles in each direction from camera

const FADE_NEAR = 80;        // m – full opacity inside this
const FADE_FAR  = 500;       // m – fully transparent beyond this

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
    south: ty * TILE_LAT,       north: (ty + 1) * TILE_LAT,
    west:  tx * TILE_LON,       east:  (tx + 1) * TILE_LON,
  };
}

// ─── Overpass ────────────────────────────────────────────────────────────────

async function fetchOSMBbox(bbox) {
  const { south, west, north, east } = bbox;
  const query = [
    '[out:json][timeout:30];(',
    `way["building"](${south},${west},${north},${east});`,
    `way["highway"](${south},${west},${north},${east});`,
    ');out body;>;out skel qt;',
  ].join('');

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── OSM parsing ─────────────────────────────────────────────────────────────

function buildNodeMap(osm) {
  const map = new Map();
  for (const el of osm.elements) {
    if (el.type === 'node') map.set(el.id, project(el.lat, el.lon));
  }
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
  'proposed', 'construction', 'elevator', 'steps', 'corridor', 'platform', 'raceway',
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

// ─── Colour palette ──────────────────────────────────────────────────────────

function heightColor(h) {
  const t = Math.min(h / 160, 1);
  return new THREE.Color().setHSL((230 + t * 70) / 360, 0.35 + t * 0.35, 0.14 + t * 0.50);
}

function streetColor(type) {
  if (['motorway','motorway_link','trunk','trunk_link','primary','primary_link'].includes(type))
    return new THREE.Color(0x5a6890);
  if (['secondary','secondary_link','tertiary','tertiary_link'].includes(type))
    return new THREE.Color(0x404f70);
  if (['pedestrian','footway','path','cycleway'].includes(type))
    return new THREE.Color(0x283248);
  return new THREE.Color(0x323c58);
}

// ─── Shaders ─────────────────────────────────────────────────────────────────

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

// EdgesGeometry layer — 80% base opacity, distance fade
const EDGES_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float fade = 1.0 - smoothstep(uNear, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.8 * fade);
  }
`;

// WireframeGeometry layer — 100% opacity, same distance fade
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

// Streets — slightly earlier fade-in
const STREET_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float fade = 1.0 - smoothstep(uNear * 0.5, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.9 * fade);
  }
`;

function fadeUniforms() {
  return { uNear: { value: FADE_NEAR }, uFar: { value: FADE_FAR } };
}

function createMaterials() {
  return {
    edges: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: EDGES_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
    }),
    wireframe: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: WIRE_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
    }),
    street: new THREE.ShaderMaterial({
      vertexShader: LINE_VERT, fragmentShader: STREET_FRAG,
      uniforms: fadeUniforms(), transparent: true, depthWrite: false,
    }),
  };
}

// ─── Geometry builders ───────────────────────────────────────────────────────

// Solid prism geometry for a single building — used as input to
// EdgesGeometry and WireframeGeometry which analyse the triangle topology.
function buildSingleBuildingGeo(ring, height) {
  const pos = [], norm = [], idx = [];
  let v = 0;
  const n = ring.length;

  // Roof
  const flat = ring.flatMap(([x, z]) => [x, z]);
  const tris = earcut(flat);
  if (!tris.length) return null;

  const rb = v;
  for (const [x, z] of ring) { pos.push(x, height, z); norm.push(0, 1, 0); v++; }
  for (const i of tris) idx.push(rb + i);

  // Walls — each as two triangles so EdgesGeometry sees the quad edges
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

// Merge all EdgesGeometry outputs into one LineSegments.
// EdgesGeometry suppresses coplanar edges (the earcut diagonals on flat roofs
// and the quad-split diagonal on each wall) — leaving only real corners.
function buildEdgesGeoMesh(buildings, mat) {
  const allPos = [], allCol = [];

  for (const { ring, height } of buildings) {
    const base = buildSingleBuildingGeo(ring, height);
    if (!base) continue;

    const edgesGeo = new THREE.EdgesGeometry(base);
    const posAttr  = edgesGeo.getAttribute('position');

    const c = heightColor(height);
    // Brighten so architectural outlines pop against the wireframe layer
    const r = Math.min(c.r * 2.0 + 0.3, 1);
    const g = Math.min(c.g * 2.0 + 0.3, 1);
    const b = Math.min(c.b * 2.0 + 0.3, 1);

    for (let i = 0; i < posAttr.count; i++) {
      allPos.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      allCol.push(r, g, b);
    }

    base.dispose();
    edgesGeo.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(allCol, 3));
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 1;
  return lines;
}

// Merge all WireframeGeometry outputs into one LineSegments.
// WireframeGeometry draws every triangle edge — including the earcut diagonals
// and the quad-split diagonal on walls — giving the full triangulation texture.
function buildWireframeGeoMesh(buildings, mat) {
  const allPos = [], allCol = [];

  for (const { ring, height } of buildings) {
    const base = buildSingleBuildingGeo(ring, height);
    if (!base) continue;

    const wireGeo = new THREE.WireframeGeometry(base);
    const posAttr = wireGeo.getAttribute('position');

    const c = heightColor(height);

    for (let i = 0; i < posAttr.count; i++) {
      allPos.push(posAttr.getX(i), posAttr.getY(i), posAttr.getZ(i));
      allCol.push(c.r, c.g, c.b);
    }

    base.dispose();
    wireGeo.dispose();
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(allCol, 3));
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 2;
  return lines;
}

function buildStreetLines(streets, mat) {
  const pos = [], col = [];

  for (const { coords, highway } of streets) {
    const c = streetColor(highway);
    for (let i = 0; i < coords.length - 1; i++) {
      const [x0, z0] = coords[i], [x1, z1] = coords[i + 1];
      pos.push(x0, 0.2, z0,  x1, 0.2, z1);
      col.push(c.r, c.g, c.b,  c.r, c.g, c.b);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(col, 3));
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 0;
  return lines;
}

// ─── Tile manager ────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

class TileManager {
  constructor(scene, mats, statusEl) {
    this.scene     = scene;
    this.mats      = mats;
    this.statusEl  = statusEl;
    this.tiles     = new Map();   // key → 'queued' | 'loading' | 'done' | 'failed'
    this.queue     = [];
    this.seenIds   = new Set();   // dedup OSM way IDs across tiles
    this.buildings = 0;
    this.streets   = 0;
    this.busy      = false;
  }

  key(tx, ty) { return `${tx}_${ty}`; }

  request(tx, ty) {
    const k = this.key(tx, ty);
    if (this.tiles.has(k)) return;
    this.tiles.set(k, 'queued');
    this.queue.push({ tx, ty, k });
  }

  // Sort so center-of-interest tile (first added) stays first
  update(camX, camZ) {
    const { lat, lon } = worldToGeo(camX, camZ);
    const { tx, ty }   = latLonToTile(lat, lon);
    this.request(tx, ty);                          // center first
    for (let dy = -LOAD_RADIUS; dy <= LOAD_RADIUS; dy++) {
      for (let dx = -LOAD_RADIUS; dx <= LOAD_RADIUS; dx++) {
        if (dx || dy) this.request(tx + dx, ty + dy);
      }
    }
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

      const group = new THREE.Group();
      if (bldgs.length) {
        group.add(buildEdgesGeoMesh(bldgs, this.mats.edges));
        group.add(buildWireframeGeoMesh(bldgs, this.mats.wireframe));
        this.buildings += bldgs.length;
      }
      if (strs.length) {
        group.add(buildStreetLines(strs, this.mats.street));
        this.streets += strs.length;
      }
      this.scene.add(group);
      this.tiles.set(k, 'done');
      this._updateStatus();
    } catch (err) {
      console.warn(`Tile ${tx},${ty}:`, err.message);
      this.tiles.set(k, 'failed');
    }
  }

  _updateStatus() {
    const queued = this.queue.length;
    let text = `${this.buildings.toLocaleString()} buildings · ${this.streets.toLocaleString()} streets`;
    if (queued) text += ` · ${queued} tile${queued > 1 ? 's' : ''} queued`;
    this.statusEl.textContent = text;
  }

  get hasData() { return this.buildings > 0; }
}

// ─── Scene setup ─────────────────────────────────────────────────────────────

function initScene() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x050810);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // Wide FOV for pedestrian / fisheye feel
  const camera = new THREE.PerspectiveCamera(90, innerWidth / innerHeight, 0.5, 2000);
  camera.position.set(0, 1.6, 50);   // eye level, 50 m south of the crossing

  // Dark ground slab
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.MeshBasicMaterial({ color: 0x080e1a }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.6, 0);     // looking at the crossing
  controls.enableDamping   = true;
  controls.dampingFactor   = 0.08;
  controls.screenSpacePanning = false; // right-drag pans on ground plane
  controls.minDistance     = 2;
  controls.maxDistance     = 400;
  controls.maxPolarAngle   = Math.PI * 0.88;   // don't go below ground
  controls.minPolarAngle   = 0.05;
  controls.update();

  // Keep camera above street level
  controls.addEventListener('change', () => {
    if (camera.position.y < 1.0) camera.position.y = 1.0;
  });

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  (function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  })();

  return { scene, camera, controls };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const loadMsg  = document.getElementById('load-msg');
  const statusEl = document.getElementById('status');
  const { scene, camera, controls } = initScene();

  loadMsg.textContent = 'Fetching Shibuya from OpenStreetMap…';

  const mats    = createMaterials();
  const manager = new TileManager(scene, mats, statusEl);

  // Kick off the 3×3 tile ring around Shibuya Scramble
  manager.update(0, 0);

  // Watch for camera movement and load new tiles (throttled to every 2 s)
  let lastCheck = 0;
  controls.addEventListener('change', () => {
    const now = Date.now();
    if (now - lastCheck > 2000) {
      lastCheck = now;
      manager.update(camera.position.x, camera.position.z);
    }
  });

  // Hide splash as soon as first buildings are visible
  const poll = setInterval(() => {
    if (manager.hasData) {
      clearInterval(poll);
      const loading = document.getElementById('loading');
      loading.classList.add('fade-out');
      setTimeout(() => loading.remove(), 800);
    }
  }, 200);
}

main();
