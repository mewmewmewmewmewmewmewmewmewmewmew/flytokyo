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
  uniform float uOpacity;
  uniform float uNear;
  uniform float uFar;
  varying float vDist;
  varying vec3  vNorm;
  void main() {
    float fade = 1.0 - smoothstep(uNear, uFar, vDist);
    if (fade < 0.01) discard;
    vec3  L    = normalize(vec3(0.5, 1.0, 0.3));
    float diff = max(dot(normalize(vNorm), L), 0.0);
    gl_FragColor = vec4(uColor * (0.55 + 0.45 * diff), uOpacity * fade);
  }
`;

function makeCarMat(colorHex, opacity) {
  return new THREE.ShaderMaterial({
    vertexShader:   CAR_VERT,
    fragmentShader: CAR_FRAG,
    uniforms: {
      uColor:   { value: new THREE.Color(colorHex) },
      uOpacity: { value: opacity },
      uNear:    { value: 120 },
      uFar:     { value: 900 },
    },
    depthTest:   false,
    depthWrite:  false,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

// Two material sets — surface (50%) and underground (30%)
const MATS = {
  surface: {
    body: makeCarMat(0x1e9c52, 0.30),
    face: makeCarMat(0x166e3a, 0.30),
    roof: makeCarMat(0xd0e8cc, 0.30),
    win:  makeCarMat(0x88ccf0, 0.30),
  },
  underground: {
    body: makeCarMat(0x1e9c52, 0.20),
    face: makeCarMat(0x166e3a, 0.20),
    roof: makeCarMat(0xd0e8cc, 0.20),
    win:  makeCarMat(0x88ccf0, 0.20),
  },
};

// ─── Car geometry ─────────────────────────────────────────────────────────────
function buildCar(isUnderground) {
  const m = isUnderground ? MATS.underground : MATS.surface;
  const group = new THREE.Group();

  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.renderOrder   = 4;
    mesh.frustumCulled = false;
    group.add(mesh);
  };

  add(new THREE.BoxGeometry(CAR_W, CAR_H, CAR_L), m.body);
  add(new THREE.BoxGeometry(CAR_W - 0.2, 0.15, CAR_L - 0.4), m.roof,
      0, CAR_H / 2 + 0.08, 0);
  add(new THREE.BoxGeometry(CAR_W, CAR_H, 0.3), m.face, 0, 0,  CAR_L / 2 - 0.15);
  add(new THREE.BoxGeometry(CAR_W, CAR_H, 0.3), m.face, 0, 0, -CAR_L / 2 + 0.15);
  add(new THREE.BoxGeometry(0.1, CAR_H * 0.35, CAR_L * 0.88), m.win,
       CAR_W / 2 + 0.02, CAR_H * 0.12, 0);
  add(new THREE.BoxGeometry(0.1, CAR_H * 0.35, CAR_L * 0.88), m.win,
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

    const isUG = curve.points.length > 0 && curve.points[0].y < -1;
    const count = Math.max(1, Math.min(NUM_CARS,
      Math.floor(this.length / (CAR_L + COUPLER))));

    for (let i = 0; i < count; i++) {
      const car = buildCar(isUG);
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
