import * as THREE from 'three';
import { fishUniforms, FISH_PROJ_GLSL, FISH_FRAG_GLSL, TOON_GLSL } from './fisheye.js?v=11.90';

// ─── Car dimensions (metres) ──────────────────────────────────────────────────
const CAR_L    = 20;
const CAR_W    = 2.7;
const CAR_H    = 3.2;
const COUPLER  = 1.2;
const NUM_CARS = 8;

const TRAIN_SPEED   = 15;   // m/s
const MIN_CURVE_LEN = 25;   // metres
const TRAIN_LEN     = NUM_CARS * (CAR_L + COUPLER);  // ~170 m
const TRAIN_SPACING = TRAIN_LEN * 4;                  // 1 train + 3 gap ≈ 678 m

// ─── Car shader ───────────────────────────────────────────────────────────────
const CAR_VERT = /* glsl */`
  varying float vDist;
  varying vec3  vNorm;
  ${FISH_PROJ_GLSL}
  void main() {
    vNorm = normalMatrix * normal;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vDist   = length(mv.xyz);
    vFishView = mv.xyz;
    gl_Position = projectVertex(mv);
  }
`;

const CAR_FRAG = /* glsl */`
  uniform vec3  uColor;
  uniform float uOpacity;
  uniform float uEndFade;
  uniform float uNear;
  uniform float uFar;
  uniform float uXray;
  varying float vDist;
  varying vec3  vNorm;
  ${FISH_FRAG_GLSL}
  ${TOON_GLSL}
  void main() {
    fishClip();
    float fade = 1.0 - smoothstep(uNear, uFar, vDist);
    if (fade < 0.01) discard;
    if (uEndFade < 0.01) discard;
    vec3  N = normalize(vNorm);
    vec3  V = normalize(-vFishView);
    vec3  L = normalize(vec3(0.5, 1.0, 0.3));
    vec3  shaded = celShade(uColor, N, V, L);
    // Solid (uXray=0): full opacity. X-ray (uXray=1): the dim per-car opacity.
    float baseOp = mix(1.0, uOpacity, uXray);
    gl_FragColor = vec4(shaded, baseOp * uEndFade * fade);
  }
`;

// Materials default to SOLID mode (depth-tested, opaque); TrainSystem.setXray() flips them.
function makeCarMat(colorHex, opacity) {
  return new THREE.ShaderMaterial({
    vertexShader:   CAR_VERT,
    fragmentShader: CAR_FRAG,
    uniforms: {
      uColor:   { value: new THREE.Color(colorHex) },
      uOpacity: { value: opacity },
      uEndFade: { value: 1.0 },
      uNear:    { value: 120 },
      uFar:     { value: 900 },
      uXray:    { value: 0.0 },
      ...fishUniforms(),
    },
    depthTest:   true,
    depthWrite:  true,
    transparent: true,
    side: THREE.DoubleSide,
  });
}

function smoothstepJS(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

// ─── Car geometry — fresh materials per call so each Train owns its uniforms ──
function buildCar(isUnderground) {
  const op = isUnderground ? 0.05 : 0.10;
  const mats = [
    makeCarMat(0x1e9c52, op),   // body
    makeCarMat(0xd0e8cc, op),   // roof
    makeCarMat(0x166e3a, op),   // face front
    makeCarMat(0x166e3a, op),   // face back
    makeCarMat(0x88ccf0, op),   // window right
    makeCarMat(0x88ccf0, op),   // window left
  ];

  const group = new THREE.Group();
  const add = (geo, mat, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.renderOrder   = 4;
    mesh.frustumCulled = false;
    group.add(mesh);
  };

  add(new THREE.BoxGeometry(CAR_W, CAR_H, CAR_L),             mats[0]);
  add(new THREE.BoxGeometry(CAR_W - 0.2, 0.15, CAR_L - 0.4), mats[1], 0, CAR_H / 2 + 0.08, 0);
  add(new THREE.BoxGeometry(CAR_W, CAR_H, 0.3),               mats[2], 0, 0,  CAR_L / 2 - 0.15);
  add(new THREE.BoxGeometry(CAR_W, CAR_H, 0.3),               mats[3], 0, 0, -CAR_L / 2 + 0.15);
  add(new THREE.BoxGeometry(0.1, CAR_H * 0.35, CAR_L * 0.88), mats[4],  CAR_W / 2 + 0.02, CAR_H * 0.12, 0);
  add(new THREE.BoxGeometry(0.1, CAR_H * 0.35, CAR_L * 0.88), mats[5], -CAR_W / 2 - 0.02, CAR_H * 0.12, 0);

  return { group, mats };
}

// ─── Train ────────────────────────────────────────────────────────────────────
class Train {
  constructor(scene, curve, phaseOffset) {
    this.curve  = curve;
    this.length = curve.getLength();
    this.t      = phaseOffset;
    this.cars   = [];
    this.mats   = [];  // all materials across all cars in this train

    const isUG = curve.points.length > 0 && curve.points[0].y < -1;
    const count = Math.max(1, Math.min(NUM_CARS,
      Math.floor(this.length / (CAR_L + COUPLER))));

    for (let i = 0; i < count; i++) {
      const { group, mats } = buildCar(isUG);
      scene.add(group);
      this.cars.push(group);
      this.mats.push(...mats);
    }
  }

  update(dt) {
    this.t = (this.t + dt * TRAIN_SPEED / this.length) % 1;
    const spacing = (CAR_L + COUPLER) / this.length;

    // Fade over ~2 car lengths at each end so train dissolves instead of U-turning
    const fadeLen = Math.min(CAR_L * 2 / this.length, 0.4);
    const endFade = smoothstepJS(0, fadeLen, this.t) *
                    (1 - smoothstepJS(1 - fadeLen, 1, this.t));

    for (const mat of this.mats) mat.uniforms.uEndFade.value = endFade;

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
    for (const mat of this.mats) mat.dispose();
  }
}

// ─── TrainSystem ──────────────────────────────────────────────────────────────
export class TrainSystem {
  constructor(scene, curves) {
    this.scene  = scene;
    this.trains = [];
    this._seen  = new WeakSet();
    this.xray   = false;   // false = solid (default), true = x-ray (right-click)
    this.addCurves(curves);
  }

  addCurves(curves) {
    for (const curve of curves) {
      if (this._seen.has(curve)) continue;
      this._seen.add(curve);
      const len = curve.getLength();
      if (len < MIN_CURVE_LEN) continue;
      const n = Math.max(1, Math.floor(len / TRAIN_SPACING));
      for (let t = 0; t < n; t++) {
        const train = new Train(this.scene, curve, t / n);
        this._applyXray(train);
        this.trains.push(train);
      }
    }
  }

  _applyXray(train) {
    const x = this.xray ? 1.0 : 0.0;
    for (const mat of train.mats) {
      mat.uniforms.uXray.value = x;
      mat.depthTest  = !this.xray;
      mat.depthWrite = !this.xray;
    }
  }

  setXray(on) {
    this.xray = on;
    for (const train of this.trains) this._applyXray(train);
  }

  update(dt) {
    for (const t of this.trains) t.update(dt);
  }
}
