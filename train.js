import * as THREE from 'three';

// ─── Car dimensions (metres) ──────────────────────────────────────────────────
const CAR_L   = 20;    // length along track
const CAR_W   = 2.7;   // width
const CAR_H   = 3.2;   // height
const COUPLER = 1.2;   // gap between cars
const NUM_CARS = 8;

const TRAIN_SPEED   = 15;   // m/s (~54 km/h)
const MIN_CURVE_LEN = 25;   // skip paths shorter than one car

// Render after ground (-1), buildings (1), wireframe (2), metro tube (3)
const TRAIN_RENDER_ORDER = 4;

// Pre-allocated rotation helper
const _fwd = new THREE.Vector3(0, 0, 1);

// ─── Materials ───────────────────────────────────────────────────────────────
// depthTest:false + transparent:true so cars render through the ground plane
// and appear inside the underground tube overlay (renderOrder 4 > tube 3).
function mat(params) {
  return new THREE.MeshLambertMaterial({
    depthTest: false, depthWrite: false, transparent: true, ...params,
  });
}

const matBody  = mat({ color: 0x1e9c52 });
const matFace  = mat({ color: 0x166e3a });
const matRoof  = mat({ color: 0xd8e8d0 });
const matWin   = mat({ color: 0xb8dff7, opacity: 0.75 });
const matWheel = mat({ color: 0x444444 });

// ─── Single car mesh ─────────────────────────────────────────────────────────
// +Z = direction of travel (getTangentAt → setFromUnitVectors aligns local +Z to tangent).
function buildCar() {
  const group = new THREE.Group();

  group.add(obj(new THREE.BoxGeometry(CAR_W, CAR_H, CAR_L), matBody));

  // Roof panel
  group.add(Object.assign(
    obj(new THREE.BoxGeometry(CAR_W - 0.2, 0.15, CAR_L - 0.4), matRoof),
    { position: new THREE.Vector3(0, CAR_H / 2 + 0.075, 0) },
  ));

  // End-caps (front = +Z, rear = −Z)
  const capGeo = new THREE.BoxGeometry(CAR_W, CAR_H, 0.3);
  const front  = obj(capGeo, matFace); front.position.z =  CAR_L / 2 - 0.15;
  const rear   = obj(capGeo, matFace); rear.position.z  = -CAR_L / 2 + 0.15;
  group.add(front, rear);

  // Window strips on ±X sides
  const winGeo = new THREE.BoxGeometry(0.08, CAR_H * 0.35, CAR_L * 0.88);
  const wL = obj(winGeo, matWin); wL.position.set( CAR_W / 2 + 0.01, CAR_H * 0.12, 0);
  const wR = obj(winGeo, matWin); wR.position.set(-CAR_W / 2 - 0.01, CAR_H * 0.12, 0);
  group.add(wL, wR);

  // Bogies
  const bogieGeo = new THREE.BoxGeometry(CAR_W * 0.9, 0.5, 2.8);
  const b1 = obj(bogieGeo, matWheel); b1.position.set(0, -CAR_H / 2 - 0.25,  CAR_L * 0.32);
  const b2 = obj(bogieGeo, matWheel); b2.position.set(0, -CAR_H / 2 - 0.25, -CAR_L * 0.32);
  group.add(b1, b2);

  return group;
}

function obj(geo, mat) {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = TRAIN_RENDER_ORDER;
  return mesh;
}

// ─── Train ────────────────────────────────────────────────────────────────────
class Train {
  constructor(scene, curve, phaseOffset) {
    this.curve  = curve;
    this.length = curve.getLength();
    this.t      = phaseOffset;
    this.cars   = [];

    // Scale car count so the train fits within the curve length
    const carCount = Math.max(1, Math.min(NUM_CARS,
      Math.floor(this.length / (CAR_L + COUPLER))));
    for (let i = 0; i < carCount; i++) {
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
      const len = curve.getLength();
      if (len < MIN_CURVE_LEN) continue;

      // Space multiple trains evenly so the path looks populated
      const trainCount = Math.max(1, Math.round(len / 400));
      for (let t = 0; t < trainCount; t++) {
        this.trains.push(new Train(this.scene, curve, t / trainCount));
      }
    }
  }

  update(dt) {
    for (const train of this.trains) train.update(dt);
  }
}
