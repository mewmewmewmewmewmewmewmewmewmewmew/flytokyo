import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import earcut from 'earcut';

// ---------------------------------------------------------------------------
// Target area: Nishi-Shinjuku skyscraper district, Tokyo
// ---------------------------------------------------------------------------

const BBOX = {
  south: 35.6855,
  west:  139.6905,
  north: 35.6955,
  east:  139.7030,
};

const CENTER_LAT = (BBOX.south + BBOX.north) / 2;
const CENTER_LON = (BBOX.west  + BBOX.east)  / 2;

// Metres per degree at this latitude
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos(CENTER_LAT * Math.PI / 180);

// ---------------------------------------------------------------------------
// Coordinate projection  (lat/lon → local X/Z in metres, Y is up)
// ---------------------------------------------------------------------------

function project(lat, lon) {
  return [
    (lon - CENTER_LON) * M_PER_DEG_LON,   // x  east  → +x
    -(lat - CENTER_LAT) * M_PER_DEG_LAT,  // z  south → +z
  ];
}

// ---------------------------------------------------------------------------
// Overpass API – fetch all building ways inside the bounding box
// ---------------------------------------------------------------------------

async function fetchOSM() {
  const { south, west, north, east } = BBOX;
  const query = [
    '[out:json][timeout:30];',
    `(way["building"](${south},${west},${north},${east}););`,
    'out body;>;out skel qt;',
  ].join('');

  const res = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'data=' + encodeURIComponent(query),
  });
  if (!res.ok) throw new Error(`Overpass returned HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Parse raw OSM JSON → array of { ring, height }
// ---------------------------------------------------------------------------

function parseBuildings(osm) {
  // Build node-id → projected [x, z]
  const nodeMap = new Map();
  for (const el of osm.elements) {
    if (el.type === 'node') {
      nodeMap.set(el.id, project(el.lat, el.lon));
    }
  }

  const buildings = [];

  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags?.building) continue;

    const ring = [];
    for (const id of el.nodes) {
      const pt = nodeMap.get(id);
      if (pt) ring.push(pt);
    }

    // OSM ways close back to the first node – drop the duplicate
    if (ring.length > 1) {
      const [ax, az] = ring[0];
      const [bx, bz] = ring[ring.length - 1];
      if (ax === bx && az === bz) ring.pop();
    }

    if (ring.length < 3) continue;

    buildings.push({ ring, height: extractHeight(el.tags) });
  }

  return buildings;
}

function extractHeight(tags) {
  // Prefer explicit height in metres
  for (const key of ['height', 'building:height']) {
    if (tags[key]) {
      const v = parseFloat(tags[key]);
      if (v > 0) return v;
    }
  }
  // Fall back to storey count (3.5 m per floor)
  if (tags['building:levels']) {
    const l = parseInt(tags['building:levels'], 10);
    if (l > 0) return l * 3.5;
  }
  return 10; // default: 2-3 storey assumption
}

// ---------------------------------------------------------------------------
// Colour by height – deep-blue low buildings, bright violet skyscrapers
// ---------------------------------------------------------------------------

function heightColor(h) {
  const t = Math.min(h / 160, 1);
  // hue sweeps 230° (blue) → 300° (magenta/violet)
  const hue = (230 + t * 70) / 360;
  const sat = 0.35 + t * 0.35;
  const lgt = 0.14 + t * 0.50;
  return new THREE.Color().setHSL(hue, sat, lgt);
}

// ---------------------------------------------------------------------------
// Build one merged BufferGeometry for all buildings (single draw call)
// ---------------------------------------------------------------------------

function buildCityMesh(buildings) {
  const positions = [];
  const normals   = [];
  const colors    = [];
  const indices   = [];
  let vtx = 0;

  for (const { ring, height } of buildings) {
    const n = ring.length;

    const roofCol = heightColor(height);
    const wallCol = roofCol.clone().multiplyScalar(0.6);

    // ---- Roof -------------------------------------------------------
    // Triangulate the horizontal footprint polygon with earcut
    const flat = ring.flatMap(([x, z]) => [x, z]);
    const tris = earcut(flat);
    if (tris.length === 0) continue;

    const roofBase = vtx;
    for (const [x, z] of ring) {
      positions.push(x, height, z);
      normals.push(0, 1, 0);
      colors.push(roofCol.r, roofCol.g, roofCol.b);
      vtx++;
    }
    for (const i of tris) indices.push(roofBase + i);

    // ---- Walls ------------------------------------------------------
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const [x0, z0] = ring[i];
      const [x1, z1] = ring[j];

      // Per-wall outward normal (90° rotation of edge direction in XZ)
      const dx = x1 - x0, dz = z1 - z0;
      const len = Math.hypot(dx, dz) || 1;
      const nx = dz / len, nz = -dx / len;

      const base = vtx;
      // Four corners: bottom-left, bottom-right, top-right, top-left
      positions.push(
        x0, 0,      z0,
        x1, 0,      z1,
        x1, height, z1,
        x0, height, z0,
      );
      for (let k = 0; k < 4; k++) {
        normals.push(nx, 0, nz);
        colors.push(wallCol.r, wallCol.g, wallCol.b);
      }
      indices.push(
        base,   base+1, base+2,
        base,   base+2, base+3,
      );
      vtx += 4;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal',   new THREE.Float32BufferAttribute(normals,   3));
  geo.setAttribute('color',    new THREE.Float32BufferAttribute(colors,    3));
  geo.setIndex(indices);

  // DoubleSide so roofs and walls render regardless of polygon winding in OSM
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  return new THREE.Mesh(geo, mat);
}

// ---------------------------------------------------------------------------
// Three.js scene setup
// ---------------------------------------------------------------------------

function initScene() {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.setClearColor(0x080c14);
  document.body.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x080c14, 900, 2200);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 1, 5000);
  camera.position.set(-200, 450, 600);

  // Ambient fills shadows; directional gives shape
  scene.add(new THREE.AmbientLight(0x8090c0, 0.9));
  const sun = new THREE.DirectionalLight(0xffeedd, 1.1);
  sun.position.set(300, 500, 200);
  scene.add(sun);

  // Dark ground plane
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(4000, 4000),
    new THREE.MeshLambertMaterial({ color: 0x0b101e }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.1;
  scene.add(ground);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 40, 0);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = Math.PI / 2.05;
  controls.minDistance = 40;
  controls.maxDistance = 2500;
  controls.update();

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

  return scene;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const scene   = initScene();
  const loadMsg = document.getElementById('load-msg');
  const status  = document.getElementById('status');

  try {
    loadMsg.textContent = 'Fetching buildings from OpenStreetMap…';
    const osm = await fetchOSM();

    loadMsg.textContent = 'Building 3D geometry…';
    const buildings = parseBuildings(osm);

    if (buildings.length === 0) throw new Error('No buildings found in this area.');

    const mesh = buildCityMesh(buildings);
    scene.add(mesh);

    status.textContent = `${buildings.length.toLocaleString()} buildings`;
  } catch (err) {
    loadMsg.textContent = `Failed: ${err.message}`;
    console.error(err);
    return;
  }

  const loading = document.getElementById('loading');
  loading.classList.add('fade-out');
  setTimeout(() => loading.remove(), 800);
}

main();
