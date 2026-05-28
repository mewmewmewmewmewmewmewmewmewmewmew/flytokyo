import * as THREE from 'three';

// ─── Car dimensions (metres) ──────────────────────────────────────────────────
const CAR_L   = 20;    // length along track
const CAR_W   = 2.7;   // width
const CAR_H   = 3.2;   // height
const COUPLER = 1.2;   // gap between cars
const NUM_CARS = 8;

const TRAIN_SPEED   = 15;   // m/s (~54 km/h)
const MIN_CURVE_LEN = 150;  // skip very short fragments (metres)

// Pre-allocated rotation helper
const _fwd = new THREE.Vector3(0, 0, 1);

// ─── Materials ───────────────────────────────────────────────────────────────
const matBody  = new THREE.MeshLambertMaterial({ color: 0x1e9c52 });
const matFace  = new THREE.MeshLambertMaterial({ color: 0x166e3a });
const matRoof  = new THREE.MeshLambertMaterial({ color: 0xd8e8d0 });
const matWin   = new THREE.MeshLambertMaterial({ color: 0xb8dff7, transparent: true, opacity: 0.75 });
const matWheel = new THREE.MeshLambertMaterial({ color: 0x444444 });

// ─── Single car mesh ─────────────────────────────────────────────────────────
// The car travels along +Z (getTangentAt → setFromUnitVectors aligns local +Z to tangent).
// Cross-track dimension → X, height → Y, along-track length → Z.
function buildCar() {
  const group = new THREE.Group();

  // Body
  group.add(obj(new THREE.BoxGeometry(CAR_W, CAR_H, CAR_L), matBody));

  // Roof panel (slightly narrower and lower so it's visible as a separate piece)
  const roofGeo = new THREE.BoxGeometry(CAR_W - 0.2, 0.15, CAR_L - 0.4);
  const roof = obj(roofGeo, matRoof);
  roof.position.y = CAR_H / 2 + 0.075;
  group.add(roof);

  // End-caps (front = +Z, rear = -Z)
  const capGeo = new THREE.BoxGeometry(CAR_W, CAR_H, 0.3);
  const front  = obj(capGeo, matFace);
  const rear   = obj(capGeo, matFace);
  front.position.z =  CAR_L / 2 - 0.15;
  rear.position.z  = -CAR_L / 2 + 0.15;
  group.add(front, rear);

  // Window strips on ±X sides
  const winH   = CAR_H * 0.35;
  const winL   = CAR_L * 0.88;
  const winGeo = new THREE.BoxGeometry(0.08, winH, winL);
  const wL = obj(winGeo, matWin);
  const wR = obj(winGeo, matWin);
  wL.position.set( CAR_W / 2 + 0.01, CAR_H * 0.12, 0);
  wR.position.set(-CAR_W / 2 - 0.01, CAR_H * 0.12, 0);
  group.add(wL, wR);

  // Bogies (wheel assemblies)
  const bogieGeo = new THREE.BoxGeometry(CAR_W * 0.9, 0.5, 2.8);
  const b1 = obj(bogieGeo, matWheel);
  const b2 = obj(bogieGeo, matWheel);
  b1.position.set(0, -CAR_H / 2 - 0.25,  CAR_L * 0.32);
  b2.position.set(0, -CAR_H / 2 - 0.25, -CAR_L * 0.32);
  group.add(b1, b2);

  return group;
}

function obj(geo, mat) {
  return new THREE.Mesh(geo, mat);
}

// ─── Train: 8 cars sharing a stitched curve ───────────────────────────────────
class Train {
  constructor(scene, curve, phaseOffset) {
    this.curve  = curve;
    this.length = curve.getLength();
    this.t      = phaseOffset;
    this.cars   = [];

    for (let i = 0; i < NUM_CARS; i++) {
      const car = buildCar();
      scene.add(car);
      this.cars.push(car);
    }
  }

  update(dt) {
    this.t = (this.t + dt * TRAIN_SPEED / this.length) % 1;

    const carSpacing = (CAR_L + COUPLER) / this.length;

    for (let i = 0; i < this.cars.length; i++) {
      const ct      = ((this.t - i * carSpacing) % 1 + 1) % 1;
      const pos     = this.curve.getPointAt(ct);
      const tangent = this.curve.getTangentAt(ct);

      this.cars[i].position.copy(pos);
      // Align local +Z to the curve tangent (direction of travel)
      this.cars[i].quaternion.setFromUnitVectors(_fwd, tangent);
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

    if (!scene._trainLightAdded) {
      // Hemisphere for base fill, directional for face differentiation
      scene.add(new THREE.HemisphereLight(0xffffff, 0x888888, 0.7));
      const dir = new THREE.DirectionalLight(0xffffff, 1.2);
      dir.position.set(3, 8, 5);
      scene.add(dir);
      scene._trainLightAdded = true;
    }

    this.addCurves(curves);
  }

  addCurves(curves) {
    for (const curve of curves) {
      if (this._seen.has(curve)) continue;
      this._seen.add(curve);
      if (curve.getLength() < MIN_CURVE_LEN) continue;
      this.trains.push(new Train(this.scene, curve, Math.random()));
    }
  }

  update(dt) {
    for (const train of this.trains) train.update(dt);
  }
}
