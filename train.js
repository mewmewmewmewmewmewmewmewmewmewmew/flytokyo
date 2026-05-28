import * as THREE from 'three';

// ─── Car dimensions (metres) ──────────────────────────────────────────────────
const CAR_L   = 20;
const CAR_W   = 2.7;
const CAR_H   = 3.2;
const COUPLER = 1.2;
const NUM_CARS = 8;

const TRAIN_SPEED   = 15;   // m/s
const MIN_CURVE_LEN = 25;   // metres

// ─── Car shader ──────────────────────────────────────────────────────────────
// Same depthTest:false / overlay approach as the metro tube material.
// Uses a uniform colour + embedded Lambert calculation (no Three.js lights needed).
const CAR_VERT = /* glsl */`
  varying float vDist;
  varying vec3  vNorm;
  void main() {
    vNorm = normalMatrix * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist   = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const CAR_FRAG = /* glsl */`
  uniform vec3  uColor;
  uniform float uNear;
  uniform float uFar;
  varying float vDist;
  varying vec3  vNorm;
  void main() {
    float fade = 1.0 - smoothstep(uNear * 0.5, uFar, vDist);
    if (fade < 0.01) discard;
    vec3  L    = normalize(vec3(0.5, 1.0, 0.3));
    float diff = max(dot(normalize(vNorm), L), 0.0);
    gl_FragColor = vec4(uColor * (0.55 + 0.45 * diff), fade);
  }
`;

function makeCarMat(colorHex) {
  return new THREE.ShaderMaterial({
    vertexShader:   CAR_VERT,
    fragmentShader: CAR_FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uNear:  { value: 120 },
      uFar:   { value: 900 },
    },
    depthTest:   false,
    depthWrite:  false,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

const MAT_BODY = makeCarMat(0x1e9c52);
const MAT_FACE = makeCarMat(0x166e3a);
const MAT_ROOF = makeCarMat(0xd0e8cc);
const MAT_WIN  = makeCarMat(0x88ccf0);

// ─── Car geometry ─────────────────────────────────────────────────────────────
// +Z = direction of travel (group.lookAt makes +Z face the target).
function buildCar() {
  const group = new THREE.Group();

  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.renderOrder    = 4;   // after tube (3) and ground (-1)
    m.frustumCulled  = false;
    group.add(m);
  };

  add(new THREE.BoxGeometry(CAR_W, CAR_H, CAR_L), MAT_BODY);
  add(new THREE.BoxGeometry(CAR_W - 0.2, 0.15, CAR_L - 0.4), MAT_ROOF,
      0, CAR_H / 2 + 0.08, 0);
  add(new THREE.BoxGeometry(CAR_W, CAR_H, 0.3), MAT_FACE, 0, 0,  CAR_L / 2 - 0.15);
  add(new THREE.BoxGeometry(CAR_W, CAR_H, 0.3), MAT_FACE, 0, 0, -CAR_L / 2 + 0.15);
  add(new THREE.BoxGeometry(0.1, CAR_H * 0.35, CAR_L * 0.88), MAT_WIN,
       CAR_W / 2 + 0.02, CAR_H * 0.12, 0);
  add(new THREE.BoxGeometry(0.1, CAR_H * 0.35, CAR_L * 0.88), MAT_WIN,
      -CAR_W / 2 - 0.02, CAR_H * 0.12, 0);

  return group;
}

// ─── Train ────────────────────────────────────────────────────────────────────
class Train {
  constructor(scene, curve, phaseOffset) {
    this.curve  = curve;
    this.length = curve.getLength();
    this.t      = phaseOffset;
    this.cars   = [];

    const count = Math.max(1, Math.min(NUM_CARS,
      Math.floor(this.length / (CAR_L + COUPLER))));
    for (let i = 0; i < count; i++) {
      const car = buildCar();
      scene.add(car);
      this.cars.push(car);
    }
  }

  update(dt) {
    this.t = (this.t + dt * TRAIN_SPEED / this.length) % 1;
    const spacing = (CAR_L + COUPLER) / this.length;

    for (let i = 0; i < this.cars.length; i++) {
      const ct    = ((this.t - i * spacing) % 1 + 1) % 1;
      const pos   = this.curve.getPointAt(ct);
      const ahead = this.curve.getPointAt((ct + 0.002) % 1);
      this.cars[i].position.copy(pos);
      this.cars[i].lookAt(ahead);
    }
  }

  dispose(scene) {
    for (const car of this.cars) scene.remove(car);
  }
}

// ─── TrainSystem ──────────────────────────────────────────────────────────────
export class TrainSystem {
  constructor(scene, curves) {
    this.scene  = scene;
    this.trains = [];
    this._seen  = new WeakSet();
    this.addCurves(curves);
  }

  addCurves(curves) {
    for (const curve of curves) {
      if (this._seen.has(curve)) continue;
      this._seen.add(curve);
      const len = curve.getLength();
      if (len < MIN_CURVE_LEN) continue;
      // Space multiple trains evenly along longer paths
      const n = Math.max(1, Math.round(len / 400));
      for (let t = 0; t < n; t++) {
        this.trains.push(new Train(this.scene, curve, t / n));
      }
    }
  }

  update(dt) {
    for (const t of this.trains) t.update(dt);
  }
}
