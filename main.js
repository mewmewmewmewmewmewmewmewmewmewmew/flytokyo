import * as THREE from 'three';
import earcut from 'earcut';

// ─── Config ──────────────────────────────────────────────────────────────────

const CENTER_LAT = 35.6595;   // Shibuya Scramble Crossing
const CENTER_LON = 139.7004;

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos(CENTER_LAT * Math.PI / 180);

const TILE_LAT    = 0.005;
const TILE_LON    = 0.006;
const LOAD_RADIUS = 1;

const FADE_NEAR   = 80;
const FADE_FAR    = 500;
const METRO_DEPTH = -7;   // ≈ 2 floors underground

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
    `way["railway"](${south},${west},${north},${east});`,
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

const RAILWAY_TYPES = new Set(['rail', 'subway', 'light_rail', 'monorail', 'tram']);

function parseRailways(osm, nodeMap) {
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags?.railway) continue;
    if (!RAILWAY_TYPES.has(el.tags.railway)) continue;
    const coords = el.nodes.map(id => nodeMap.get(id)).filter(Boolean);
    if (coords.length < 2) continue;
    const isTunnel = el.tags.tunnel === 'yes';
    out.push({ id: el.id, coords, type: el.tags.railway, isTunnel });
  }
  return out;
}

// ─── Colour palette (light theme) ────────────────────────────────────────────

function heightColor(h) {
  const t = Math.min(h / 160, 1);
  return new THREE.Color().setHSL((220 + t * 15) / 360, 0.06 + t * 0.08, 0.86 - t * 0.10);
}

function wireColor(h) {
  const t = Math.min(h / 160, 1);
  return new THREE.Color().setHSL((220 + t * 15) / 360, 0.20, 0.22 + t * 0.05);
}

function streetColor(type) {
  if (['motorway','motorway_link','trunk','trunk_link','primary','primary_link'].includes(type))
    return new THREE.Color(0x3d4a6a);
  if (['secondary','secondary_link','tertiary','tertiary_link'].includes(type))
    return new THREE.Color(0x5a6280);
  if (['pedestrian','footway','path','cycleway'].includes(type))
    return new THREE.Color(0x8090a8);
  return new THREE.Color(0x6a7490);
}

// Surface JR = dark green, underground metro = indigo
function railColor(isTunnel) {
  return isTunnel ? new THREE.Color(0x5540a0) : new THREE.Color(0x3a6a40);
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
    float fade = 1.0 - smoothstep(uNear * 0.5, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.9 * fade);
  }
`;

// Metro: 50% opacity, ignores depth so it shows through the opaque ground plane
const METRO_FRAG = /* glsl */`
  varying vec3  vCol;
  varying float vDist;
  uniform float uNear;
  uniform float uFar;
  void main() {
    float fade = 1.0 - smoothstep(uNear * 0.5, uFar, vDist);
    if (fade < 0.01) discard;
    gl_FragColor = vec4(vCol, 0.5 * fade);
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
      depthTest: false,   // render through the opaque ground plane
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
    const posAttr = edgesGeo.getAttribute('position');
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

function buildRailLines(rails, yLevel, isTunnel, mat) {
  const pos = [], col = [];
  const c = railColor(isTunnel);

  for (const { coords } of rails) {
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
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = isTunnel ? 3 : 0;
  return lines;
}

// ─── Tile manager ────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

class TileManager {
  constructor(scene, mats, statusEl) {
    this.scene     = scene;
    this.mats      = mats;
    this.statusEl  = statusEl;
    this.tiles     = new Map();
    this.queue     = [];
    this.seenIds   = new Set();
    this.buildings = 0;
    this.streets   = 0;
    this.rails     = 0;
    this.busy      = false;
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
      const rails = parseRailways(osm, nodeMap)
        .filter(r => { if (this.seenIds.has(r.id)) return false; this.seenIds.add(r.id); return true; });

      const group = new THREE.Group();

      if (bldgs.length) {
        group.add(buildSurfaceMesh(bldgs, this.mats.surface));
        group.add(buildEdgesGeoMesh(bldgs, this.mats.wireframe));
        this.buildings += bldgs.length;
      }
      if (strs.length) {
        group.add(buildStreetLines(strs, this.mats.street));
        this.streets += strs.length;
      }
      if (rails.length) {
        const surface = rails.filter(r => !r.isTunnel);
        const tunnel  = rails.filter(r =>  r.isTunnel);
        const sl = buildRailLines(surface, 0.3,        false, this.mats.rail);
        const tl = buildRailLines(tunnel,  METRO_DEPTH, true,  this.mats.metro);
        if (sl) group.add(sl);
        if (tl) group.add(tl);
        this.rails += rails.length;
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
    if (this.rails) text += ` · ${this.rails} rail segments`;
    if (queued) text += ` · ${queued} tile${queued > 1 ? 's' : ''} queued`;
    this.statusEl.textContent = text;
  }

  get hasData() { return this.buildings > 0; }
}

// ─── First-person controls ───────────────────────────────────────────────────
// Left-drag: look around (yaw + pitch with coast damping).
// W/S: walk forward / backward.
// A/D: strafe left / right at half speed.

function createFPSControls(camera, domElement) {
  let yaw   = 0;
  let pitch = 0;
  let yawVel   = 0;
  let pitchVel = 0;

  const LOOK_SPEED  = 0.00175;
  const MOVE_SPEED  = 0.30;
  const STRAFE_SPEED = 0.15;
  const DAMP        = 0.85;

  const keys = new Set();
  window.addEventListener('keydown', e => keys.add(e.code));
  window.addEventListener('keyup',   e => keys.delete(e.code));

  let isDragging = false;
  let lastX = 0, lastY = 0;

  const _fwd   = new THREE.Vector3();
  const _right = new THREE.Vector3();

  function applyRotation() {
    camera.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  }

  // _right = _fwd × up = (-fwd.z, 0, fwd.x)
  function getHorizDirs() {
    _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    _fwd.y = 0; _fwd.normalize();
    _right.set(-_fwd.z, 0, _fwd.x);
  }

  domElement.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    isDragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    e.preventDefault();
  }, { passive: false });

  window.addEventListener('mousemove', e => {
    if (!isDragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    yawVel   = -dx * LOOK_SPEED;
    pitchVel = -dy * LOOK_SPEED;
    yaw   += yawVel;
    pitch  = Math.max(-Math.PI * 0.499, Math.min(Math.PI * 0.499, pitch + pitchVel));
    applyRotation();
    dispatcher.dispatchEvent({ type: 'change' });
  });

  window.addEventListener('mouseup', e => { if (e.button === 0) isDragging = false; });
  domElement.addEventListener('contextmenu', e => e.preventDefault());

  // Touch: single finger = look
  let touchLast = null;
  domElement.addEventListener('touchstart', e => {
    if (e.touches.length === 1)
      touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    e.preventDefault();
  }, { passive: false });
  domElement.addEventListener('touchmove', e => {
    if (e.touches.length === 1 && touchLast) {
      const dx = e.touches[0].clientX - touchLast.x;
      const dy = e.touches[0].clientY - touchLast.y;
      touchLast = { x: e.touches[0].clientX, y: e.touches[0].clientY };
      yawVel = -dx * LOOK_SPEED; pitchVel = -dy * LOOK_SPEED;
      yaw   += yawVel;
      pitch  = Math.max(-Math.PI * 0.499, Math.min(Math.PI * 0.499, pitch + pitchVel));
      applyRotation();
      dispatcher.dispatchEvent({ type: 'change' });
    }
    e.preventDefault();
  }, { passive: false });
  domElement.addEventListener('touchend', () => { touchLast = null; });

  const dispatcher = Object.assign(new THREE.EventDispatcher(), {
    update() {
      if (!isDragging && (Math.abs(yawVel) > 0.000001 || Math.abs(pitchVel) > 0.000001)) {
        yawVel   *= DAMP;
        pitchVel *= DAMP;
        yaw   += yawVel;
        pitch  = Math.max(-Math.PI * 0.499, Math.min(Math.PI * 0.499, pitch + pitchVel));
        applyRotation();
      }

      if (keys.has('KeyW') || keys.has('KeyS') || keys.has('KeyA') || keys.has('KeyD')) {
        getHorizDirs();
        let moved = false;
        if (keys.has('KeyW')) { camera.position.addScaledVector(_fwd,    MOVE_SPEED);   moved = true; }
        if (keys.has('KeyS')) { camera.position.addScaledVector(_fwd,   -MOVE_SPEED);   moved = true; }
        if (keys.has('KeyD')) { camera.position.addScaledVector(_right,  STRAFE_SPEED); moved = true; }
        if (keys.has('KeyA')) { camera.position.addScaledVector(_right, -STRAFE_SPEED); moved = true; }
        if (moved) dispatcher.dispatchEvent({ type: 'change' });
      }
    },
  });

  return dispatcher;
}

// ─── Scene setup ─────────────────────────────────────────────────────────────

function initScene() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0xf0f2f8);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  const camera = new THREE.PerspectiveCamera(90, innerWidth / innerHeight, 0.5, 2000);
  camera.position.set(0, 1.6, 50);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(8000, 8000),
    new THREE.MeshBasicMaterial({ color: 0xd8dce8 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.05;
  scene.add(ground);

  const controls = createFPSControls(camera, renderer.domElement);

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

  manager.update(0, 0);

  let lastCheck = 0;
  controls.addEventListener('change', () => {
    const now = Date.now();
    if (now - lastCheck > 2000) {
      lastCheck = now;
      manager.update(camera.position.x, camera.position.z);
    }
  });

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
