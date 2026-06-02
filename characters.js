import * as THREE from 'three';

// ─── Flight characters (the avatar the camera follows) ────────────────────────
// Pluggable so more avatars can be added later and switched at runtime. Each
// character entry in CHARACTERS exposes:
//   build(applyFisheye)      → THREE.Group  (its mesh; materials are routed
//                              through the shared fisheye projection via the
//                              applyFisheye wrapper passed in from main.js)
//   createController(mesh)   → { update(dt, now, ctx) }  (owns the character's
//                              per-frame animation; ctx carries flight state such
//                              as { pitch } so the controller stays decoupled from
//                              the camera/controls). main.js positions the group;
//                              the controller only animates the character itself.
// Today only the swallow exists and is the default; adding a character is just a
// new build()/createController() pair registered in CHARACTERS.

// ─── Swallow (default bird) ───────────────────────────────────────────────────
function buildBirdMesh(applyFisheye) {
  const group   = new THREE.Group();
  const matBeak = applyFisheye(new THREE.MeshBasicMaterial({ color: 0x7b919d, wireframe: true }));
  // Body, wings + tail are drawn as EDGE lines only (no inner triangulation),
  // all in the same colour.
  const matLine = applyFisheye(new THREE.LineBasicMaterial({ color: 0x2c8fc7 }));

  // Bird faces −Z (Three.js default forward). Dorsal (top-down) layout:
  //  −Z = head/beak, +Z = tail, ±X = wingtips, +Y = up (back).

  // ── Body + tail as ONE continuous form ──────────────────────────────────
  // The body's outer silhouette flows back and out into the tail's outer edges
  // (no separate teardrop that ends in a point). Up front a slight bulb reads
  // as the head; the chest is the widest point; the body narrows to a slim
  // waist and the same side lines continue out to the forked tail tips. Cross
  // sections are wider than tall (height ≈ 0.82 × width) and flatten toward the
  // tail. Drawn as minimal edge lines.
  function buildBodyTail() {
    const yMid  = 0.02;
    // Short body: the head sits just ahead of the wing leading edge (root ≈
    // z −0.30) rather than out at a long nose tip.
    const zNose = -0.45, zWaist = 0.58;          // body runs nose → waist
    const tipX  = 0.36, tipZ = 1.85, notchZ = 1.02;
    const Wwaist = 0.10;
    // Half-width (W) and half-height (H) control points along the body
    // (u: 0 = nose … 1 = waist). Interpolated with smoothstep so the widest
    // part is a ROUNDED curve, not two straight edges meeting at a peak, and
    // the short front rounds off into a blunt head (no pointy tip).
    const Wc = [[0,0],[0.15,0.110],[0.36,0.170],[1.0,Wwaist]];
    const Hc = [[0,0],[0.15,0.090],[0.36,0.140],[1.0,0.020]];
    const interp = (c, u) => {
      for (let i = 0; i < c.length - 1; i++)
        if (u <= c[i+1][0]) {
          const r = (u - c[i][0]) / (c[i+1][0] - c[i][0]);
          const t = r * r * (3 - 2 * r);               // smoothstep → rounded joints
          return c[i][1] + (c[i+1][1] - c[i][1]) * t;
        }
      return c[c.length - 1][1];
    };
    const zBody = u => zNose + (zWaist - zNose) * u;
    const verts = [];
    // Add a polyline through the given [x,y,z] points as connected segments.
    const polyline = (pts) => {
      for (let i = 0; i < pts.length - 1; i++)
        verts.push(pts[i][0], pts[i][1], pts[i][2], pts[i+1][0], pts[i+1][1], pts[i+1][2]);
    };
    const nU = 20;

    // 1. Side outline (each side): nose → body sides → waist → tail tip (one curve).
    for (const sx of [1, -1]) {
      const pts = [[0, yMid, zNose]];
      for (let i = 1; i <= nU; i++) { const u = i/nU; pts.push([sx*interp(Wc,u), yMid, zBody(u)]); }
      const nT = 6;
      for (let i = 1; i <= nT; i++) {
        const t = i/nT;
        pts.push([sx*(Wwaist + (tipX-Wwaist)*t), yMid, zWaist + (tipZ-zWaist)*t]);
      }
      polyline(pts);
    }
    // 2. Top + bottom ridges (body only) — give it height up front, flat by the waist.
    for (const sy of [1, -1]) {
      const pts = [[0, yMid, zNose]];
      for (let i = 1; i <= nU; i++) { const u = i/nU; pts.push([0, yMid + sy*interp(Hc,u), zBody(u)]); }
      polyline(pts);
    }
    // 3. A few cross-section rings on the body front (wider than tall).
    const nPhi = 12;
    for (const u of [0.20, 0.42, 0.70]) {
      const w = interp(Wc,u), h = interp(Hc,u), z = zBody(u);
      const pts = [];
      for (let j = 0; j <= nPhi; j++) { const phi = j/nPhi*Math.PI*2; pts.push([w*Math.cos(phi), yMid + h*Math.sin(phi), z]); }
      polyline(pts);
    }
    // 4. Tail rounded fork trailing edge (parabola, right tip → notch → left tip).
    const fork = [];
    for (let k = 0; k <= 16; k++) { const a = 1 - 2*k/16; fork.push([a*tipX, yMid, notchZ + (tipZ-notchZ)*a*a]); }
    polyline(fork);
    // 5. Tail centre spine (waist → notch).
    polyline([[0, yMid, zWaist], [0, yMid, notchZ]]);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mesh = new THREE.LineSegments(geo, matLine);
    // Stash rest positions + the waist Z so the animate loop can flutter only
    // the tail (vertices behind the waist) in the wind.
    mesh.userData = { rest: Float32Array.from(verts), zWaist };
    return mesh;
  }
  // ── Body+tail planform fill ──────────────────────────────────────────────
  // Flat mesh at y=yMid tracing the same silhouette as the edge lines.
  // Body: quad strip nose→waist; tail: fan from notch out to both fork arms.
  // userData.{rest, zWaist} matches what flutterTail expects so the surface
  // waves in the wind together with the edge lines.
  function buildBodyTailSurface() {
    const yMid = 0.02;
    const zNose = -0.45, zWaist = 0.58;
    const tipX = 0.36, tipZ = 1.85, notchZ = 1.02;
    const Wwaist = 0.10;
    const Wc = [[0,0],[0.15,0.110],[0.36,0.170],[1.0,Wwaist]];
    const interp = (c, u) => {
      for (let i = 0; i < c.length - 1; i++)
        if (u <= c[i+1][0]) {
          const r = (u - c[i][0]) / (c[i+1][0] - c[i][0]);
          const t = r * r * (3 - 2 * r);
          return c[i][1] + (c[i+1][1] - c[i][1]) * t;
        }
      return c[c.length - 1][1];
    };
    const zBody = u => zNose + (zWaist - zNose) * u;
    const pos = [], idx = [];
    const addV = (x, z) => { pos.push(x, yMid, z); return pos.length / 3 - 1; };

    // Body: sample nU+1 stations nose→waist, build quad strip
    const nU = 20;
    const lv = [], rv = [];
    for (let i = 0; i <= nU; i++) {
      const u = i / nU, w = interp(Wc, u), z = zBody(u);
      rv.push(addV( w, z));
      lv.push(addV(-w, z));
    }
    for (let i = 0; i < nU; i++) {
      idx.push(lv[i], rv[i], rv[i+1]);
      idx.push(lv[i], rv[i+1], lv[i+1]);
    }

    // Tail: a single triangle fan from the waist centre over the whole fork
    // outline. From (0,zWaist) the swallowtail is star-shaped, so fanning the
    // ordered boundary (waist-right → tip-right → notch → tip-left → waist-left)
    // tiles it with no gaps or overlaps.
    const nT = 6, nFork = 16;
    const centreV = addV(0, zWaist);
    const bnd = [rv[nU]];                                  // waist-right
    for (let i = 1; i <= nT; i++) {                        // right edge → tip-right
      const t = i / nT;
      bnd.push(addV(Wwaist + (tipX - Wwaist) * t, zWaist + (tipZ - zWaist) * t));
    }
    for (let k = 1; k <= nFork; k++) {                    // fork tip-right → notch → tip-left
      const a = 1 - 2 * k / nFork;
      bnd.push(addV(a * tipX, notchZ + (tipZ - notchZ) * a * a));
    }
    for (let i = nT - 1; i >= 1; i--) {                   // tip-left → left edge
      const t = i / nT;
      bnd.push(addV(-(Wwaist + (tipX - Wwaist) * t), zWaist + (tipZ - zWaist) * t));
    }
    bnd.push(lv[nU]);                                     // waist-left
    for (let i = 0; i < bnd.length - 1; i++) idx.push(centreV, bnd[i], bnd[i + 1]);

    const surfGeo = new THREE.BufferGeometry();
    surfGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    surfGeo.setIndex(idx);
    const surf = new THREE.Mesh(surfGeo, applyFisheye(new THREE.MeshBasicMaterial({
      color: 0x2c8fc7, transparent: true, opacity: 0.50,
      depthWrite: false, side: THREE.DoubleSide,
    })));
    surf.userData = { rest: Float32Array.from(pos), zWaist };
    return surf;
  }

  const bodyTail = buildBodyTail();
  const bodyTailSurf = buildBodyTailSurface();
  group.add(bodyTailSurf);   // surface first so edge lines render on top
  group.add(bodyTail);
  group.userData.bodyTail     = bodyTail;
  group.userData.bodyTailSurf = bodyTailSurf;

  // ── Beak: short stubby black cone pointing −Z, mounted at the nose ──
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 4, 1), matBeak);
  beak.rotation.x = -Math.PI / 2;       // +Y axis → −Z
  beak.position.set(0, 0.02, -0.50);
  group.add(beak);

  // ── Wings: swallow silhouette — EDGE LINES only (leading + trailing outline,
  // a root rib and a few feather ribs), no inner triangulation. ──
  // Leading edge sweeps back MONOTONICALLY from the root so both wings' front
  // edges meet at the body at one shared angle (a continuous chevron). The
  // trailing edge meets it at the tip. Span ≈2/3 of the old reach; the
  // near-root slope (0.55/1.46 ≈ 0.38 z per x) sets the bird's chevron angle,
  // reused by the tail below. userData carries rest/tt/sx so the flap deformer
  // can flex these line vertices per-frame exactly like the old mesh.
  function buildWing(sx) {
    const n = 16;
    const st = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const e = t * t * (3 - 2 * t);
      st.push({
        t,
        x:  sx * (0.15 + 1.46 * t),          // span (≈2/3 of the previous 2.18)
        y:  0.06 - 0.13 * e,                 // slight dihedral droop
        zF: -0.30 + 0.55 * t + 0.65 * t * t, // leading edge (monotonic chevron)
        zB:  0.25 + 0.61 * t + 0.04 * t * t, // trailing edge → meets leading at tip
      });
    }
    const verts = [], tts = [];
    const add = (s, back) => { verts.push(s.x, s.y, back ? s.zB : s.zF); tts.push(s.t); };
    for (let i = 0; i < n - 1; i++) { add(st[i], false); add(st[i+1], false); } // leading edge
    for (let i = 0; i < n - 1; i++) { add(st[i], true);  add(st[i+1], true);  } // trailing edge
    add(st[0], false); add(st[0], true);                                        // root rib
    for (const f of [0.45, 0.65, 0.82]) {                                       // feather ribs
      const i = Math.round(f * (n - 1)); add(st[i], false); add(st[i], true);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    const mesh = new THREE.LineSegments(geo, matLine);
    mesh.userData = { rest: Float32Array.from(verts), tt: Float32Array.from(tts),
                      count: verts.length / 3, sx };

    // ── Solid surface membrane (30 % blue fill) ──────────────────────────────
    // 2*n vertices: first n = leading edge, next n = trailing edge.
    // Same userData format as the line mesh so deformWing() works on it directly.
    const surfPos = [], surfTt = [];
    for (const s of st) { surfPos.push(s.x, s.y, s.zF); surfTt.push(s.t); }
    for (const s of st) { surfPos.push(s.x, s.y, s.zB); surfTt.push(s.t); }
    const surfIdx = [];
    for (let i = 0; i < n - 1; i++) {
      surfIdx.push(i, n + i, i + 1);
      surfIdx.push(n + i, n + i + 1, i + 1);
    }
    const surfGeo = new THREE.BufferGeometry();
    surfGeo.setAttribute('position', new THREE.Float32BufferAttribute(surfPos, 3));
    surfGeo.setIndex(surfIdx);
    const surfMat = applyFisheye(new THREE.MeshBasicMaterial({
      color: 0x2c8fc7, transparent: true, opacity: 0.50,
      depthWrite: false, side: THREE.DoubleSide,
    }));
    const surfMesh = new THREE.Mesh(surfGeo, surfMat);
    surfMesh.userData = { rest: Float32Array.from(surfPos), tt: Float32Array.from(surfTt),
                          count: surfPos.length / 3, sx };

    mesh.userData.surface = surfMesh;
    return mesh;
  }
  const wingR = buildWing( 1);
  const wingL = buildWing(-1);
  // Surface fill meshes draw first (lower renderOrder) so edge lines always sit
  // on top regardless of depth-fighting at the thin wing profile.
  group.add(wingR.userData.surface);
  group.add(wingL.userData.surface);
  group.add(wingR);
  group.add(wingL);
  // Exposed so the animate loop can flap/flex/tuck them per-vertex.
  group.userData.wingR    = wingR;
  group.userData.wingL    = wingL;
  group.userData.surfaceR = wingR.userData.surface;
  group.userData.surfaceL = wingL.userData.surface;

  group.scale.setScalar(0.5);   // half size

  return group;
}

// Owns the swallow's wing-flap + tail-flutter animation. Returns an updater the
// main loop calls each frame with (dt, now, { pitch }).
function createBirdController(mesh) {
  // Wing-flap state. The bird flaps in short bursts then glides, the way a
  // swallow actually flies. Each wing is deformed as a flexible membrane: the
  // flap angle grows along the span and lags in phase toward the tip (so the
  // motion ripples outward, not like a rigid board), with a chordwise twist
  // that feathers the wing through the stroke. When the bird dives the wings
  // stop flapping and tuck back into a swept glide.
  const wingR    = mesh.userData.wingR;
  const wingL    = mesh.userData.wingL;
  const surfaceR = mesh.userData.surfaceR;
  const surfaceL = mesh.userData.surfaceL;
  const bodyTail     = mesh.userData.bodyTail;
  const bodyTailSurf = mesh.userData.bodyTailSurf;

  // Apply tail-wind flutter to one geometry buffer (lines or surface mesh).
  function _flutterGeo(mesh, t) {
    const arr = mesh.geometry.attributes.position.array;
    const rest = mesh.userData.rest, zW = mesh.userData.zWaist;
    for (let k = 0; k < rest.length; k += 3) {
      const z = rest[k + 2];
      if (z <= zW) continue;
      const f = z - zW;
      arr[k]     = rest[k]     + Math.sin(t * 5.5 + z * 1.6) * 0.018 * f;
      arr[k + 1] = rest[k + 1] + Math.sin(t * 4.0 + z * 2.2) * 0.030 * f;
    }
    mesh.geometry.attributes.position.needsUpdate = true;
  }

  function flutterTail(now) {
    const t = now * 0.001;
    if (bodyTail)     _flutterGeo(bodyTail, t);
    if (bodyTailSurf) _flutterGeo(bodyTailSurf, t);
  }

  let flapPhase  = 0;     // running flap phase (shoulder); tips lag behind
  let flapAmp    = 0.06;  // current (eased) amplitude in radians
  let flapFreq   = 2;     // current (eased) angular speed
  let flapBurst  = 0;     // seconds left in the current flapping burst
  let glideTimer = 1.0;   // seconds until the next burst is allowed to start
  let wingTuck   = 0;     // 0 = spread, 1 = full dive tuck (eased toward dive steepness)
  // Per-beat randomisation so consecutive wingbeats differ in strength and tempo.
  let beatCount    = 0;   // increments every full 2π cycle
  let beatAmpScale = 1.0; // amplitude multiplier re-randomised each beat
  let beatFreqMul  = 1.0; // frequency multiplier re-randomised each beat
  const WING_LAG   = 1.0; // phase lag from shoulder to tip → travelling-wave flex
  const WING_TWIST = 0.22;// chordwise feathering amplitude
  const DIVE_DIHEDRAL = Math.PI / 4;  // max upward wing slant in a full dive (45°)

  // Deform one wing from its rest geometry: tuck (dive sweep + raised dihedral)
  // → twist (feather) → flap (span- and phase-dependent bend about the body
  // axis). Recomputed from rest each frame so nothing accumulates/drifts.
  function deformWing(mesh, amp, phase, tuck) {
    const ud = mesh.userData, sx = ud.sx, rest = ud.rest, tt = ud.tt;
    const arr = mesh.geometry.attributes.position.array;
    for (let k = 0; k < ud.count; k++) {
      const t    = tt[k];
      const span = Math.pow(t, 1.25);               // tip flexes far more than root
      let x = rest[k*3], y = rest[k*3+1], z = rest[k*3+2];
      // Dive tuck: fold the span in and sweep the tips back a little.
      // (tips already sit at z+0.90 in rest pose; keep tuck sweep modest)
      if (tuck > 0.001) {
        z += tuck * span * 0.35;
        x -= sx   * tuck * span * 0.55;
      }
      const ph = phase - WING_LAG * t;              // tip lags the shoulder
      // Asymmetric stroke: the wing sweeps DOWN its full distance (power stroke)
      // but rises only ~half as far on the UPstroke (recovery), like a real bird.
      let sUp = Math.sin(ph);
      sUp = sUp > 0 ? sUp * 0.5 : sUp;              // positive = up → halve it
      // Twist about the spanwise (x) axis — feathers the chord with flap speed.
      const tw = sx * WING_TWIST * span * Math.cos(ph) * amp * (1 - tuck);
      if (tw) { const c = Math.cos(tw), s = Math.sin(tw); const ny = y*c - z*s, nz = y*s + z*c; y = ny; z = nz; }
      // Rotate about the body (z) axis: resting dihedral + a steady upward dive
      // slant (constant across span → a straight raised V, up to 45°) + the
      // phase-lagged flap bend (faded out as the wings tuck for the dive).
      const a = sx * (0.05 * span
                    + DIVE_DIHEDRAL * tuck
                    + amp * span * sUp * (1 - 0.6 * tuck));
      const c = Math.cos(a), s = Math.sin(a);
      arr[k*3]   = x*c - y*s;
      arr[k*3+1] = x*s + y*c;
      arr[k*3+2] = z;
    }
    mesh.geometry.attributes.position.needsUpdate = true;
  }

  return {
    update(dt, now, ctx) {
    if (wingR && wingL) {
      const pitch    = ctx.pitch;             // <0 = nose-down (diving)
      const diveFrac = Math.max(0, Math.min(1, (-pitch - 0.2) / (Math.PI / 2 - 0.2)));
      const diving   = diveFrac > 0.05;
      wingTuck += (diveFrac - wingTuck) * Math.min(dt * 4, 1);

      glideTimer -= dt;
      if (diving) flapBurst = 0;                          // never flap mid-dive
      else if (flapBurst <= 0 && glideTimer <= 0) {
        // Vary how long the bird flaps AND how long it glides afterward so
        // consecutive bursts feel unpredictable, not metronomic.
        flapBurst  = 0.35 + Math.random() * 1.2;
        glideTimer = 0.8  + Math.random() * 3.5;
      }
      let ampTarget, freqTarget;
      if (flapBurst > 0 && !diving) {
        flapBurst -= dt;
        ampTarget = 0.85; freqTarget = 15;
      } else {
        ampTarget = 0.05; freqTarget = 2.2;              // relaxed glide + idle bob
      }
      flapAmp  += (ampTarget  - flapAmp)  * Math.min(dt * 6, 1);
      flapFreq += (freqTarget - flapFreq) * Math.min(dt * 6, 1);

      // Re-randomise amplitude and tempo at the start of each new beat cycle so
      // no two wingbeats are identical — breaks the robotic regularity.
      const newBeat = Math.floor(flapPhase / (2 * Math.PI));
      if (newBeat > beatCount) {
        beatCount    = newBeat;
        beatAmpScale = 0.72 + Math.random() * 0.56;   // 0.72 – 1.28 × amplitude
        beatFreqMul  = 0.82 + Math.random() * 0.36;   // 0.82 – 1.18 × tempo
      }
      flapPhase += dt * flapFreq * (flapBurst > 0 ? beatFreqMul : 1);
      const beatAmp = flapAmp * (flapBurst > 0 ? beatAmpScale : 1);
      deformWing(wingR, beatAmp, flapPhase, wingTuck);
      deformWing(wingL, beatAmp, flapPhase, wingTuck);
      if (surfaceR) deformWing(surfaceR, beatAmp, flapPhase, wingTuck);
      if (surfaceL) deformWing(surfaceL, beatAmp, flapPhase, wingTuck);
    }
    flutterTail(now);
    },
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────
export const CHARACTERS = {
  bird: {
    id:   'bird',
    name: 'Swallow',
    build: applyFisheye => buildBirdMesh(applyFisheye),
    createController: mesh => createBirdController(mesh),
  },
};

export const DEFAULT_CHARACTER = 'bird';
