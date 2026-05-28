import * as THREE from 'three';

// ─── Car dimensions (metres) ──────────────────────────────────────────────────
const CAR_L   = 20;    // length along track
const CAR_W   = 2.7;   // width
const CAR_H   = 3.2;   // height
const COUPLER = 1.2;   // gap between cars
const NUM_CARS = 8;

const LOOP_SECONDS  = 20;   // time for the train to traverse one curve end-to-end
const MIN_CURVE_LEN = 200;  // ignore very short fragments (metres)

// ─── Materials ───────────────────────────────────────────────────────────────
const matBody = new THREE.MeshLambertMaterial({ color: 0x1e9c52 });  // metro green
const matFace = new THREE.MeshLambertMaterial({ color: 0x166e3a });  // darker ends
const matWin  = new THREE.MeshLambertMaterial({ color: 0xb8dff7, transparent: true, opacity: 0.75 });
const matWheel = new THREE.MeshLambertMaterial({ color: 0x444444 });

// ─── Single car mesh ─────────────────────────────────────────────────────────
function buildCar() {
  const group = new THREE.Group();

  // Body
  group.add(obj(new THREE.BoxGeometry(CAR_L, CAR_H, CAR_W), matBody));

  // Front / rear faces (slightly inset end-caps)
  const capGeo = new THREE.BoxGeometry(0.3, CAR_H, CAR_W);
  const front  = obj(capGeo, matFace);
  const rear   = obj(capGeo, matFace);
  front.position.x =  CAR_L / 2 - 0.15;
  rear.position.x  = -CAR_L / 2 + 0.15;
  group.add(front, rear);

  // Window strip — two long strips on each side
  const winH = CAR_H * 0.35;
  const winL = CAR_L * 0.88;
  const winGeo = new THREE.BoxGeometry(winL, winH, 0.05);
  const wL = obj(winGeo, matWin);
  const wR = obj(winGeo, matWin);
  wL.position.set(0,  CAR_H * 0.12,  CAR_W / 2 + 0.01);
  wR.position.set(0,  CAR_H * 0.12, -CAR_W / 2 - 0.01);
  group.add(wL, wR);

  // Bogies (wheel assemblies) — flat boxes under the car
  const bogieGeo = new THREE.BoxGeometry(2.5, 0.4, CAR_W * 0.9);
  const b1 = obj(bogieGeo, matWheel);
  const b2 = obj(bogieGeo, matWheel);
  b1.position.set( CAR_L * 0.32, -CAR_H / 2 - 0.2, 0);
  b2.position.set(-CAR_L * 0.32, -CAR_H / 2 - 0.2, 0);
  group.add(b1, b2);

  return group;
}

function obj(geo, mat) {
  return new THREE.Mesh(geo, mat);
}

// ─── Train: 8 independent car meshes sharing a curve ────────────────────────
class Train {
  constructor(scene, curve, phaseOffset) {
    this.curve  = curve;
    this.length = curve.getLength();
    this.t      = phaseOffset;  // 0-1 start position
    this.cars   = [];

    for (let i = 0; i < NUM_CARS; i++) {
      const car = buildCar();
      // Cars need a directional light to look non-flat
      scene.add(car);
      this.cars.push(car);
    }
  }

  update(dt) {
    this.t = (this.t + dt / LOOP_SECONDS) % 1;

    const carSpacing = (CAR_L + COUPLER) / this.length; // spacing as fraction of curve

    for (let i = 0; i < this.cars.length; i++) {
      const ct = ((this.t - i * carSpacing) % 1 + 1) % 1;
      const pos = this.curve.getPointAt(ct);

      // Tangent for orientation — sample slightly ahead to avoid numerical noise
      const ct2 = (ct + 0.0002) % 1;
      const ahead = this.curve.getPointAt(ct2);

      this.cars[i].position.copy(pos);
      this.cars[i].lookAt(ahead);
    }
  }

  dispose(scene) {
    for (const car of this.cars) scene.remove(car);
  }
}

// ─── TrainSystem — one Train per qualifying metro curve ───────────────────────
export class TrainSystem {
  constructor(scene, curves) {
    this.scene  = scene;
    this.trains = [];
    this._seen  = new WeakSet();

    // Add a hemisphere light if the scene has none — needed for Lambert materials
    if (!scene._trainLightAdded) {
      scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 1.2));
      scene._trainLightAdded = true;
    }

    this.addCurves(curves);
  }

  addCurves(curves) {
    for (const curve of curves) {
      if (this._seen.has(curve)) continue;
      this._seen.add(curve);
      if (curve.getLength() < MIN_CURVE_LEN) continue;
      // Stagger starting positions so trains are spread out on each line
      const phase = Math.random();
      this.trains.push(new Train(this.scene, curve, phase));
    }
  }

  update(dt) {
    for (const train of this.trains) train.update(dt);
  }
}
