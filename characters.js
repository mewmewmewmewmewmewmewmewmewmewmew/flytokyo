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

// ─── Anime girl (F3) ─────────────────────────────────────────────────────────
function buildGirlMesh(applyFisheye) {
  const group   = new THREE.Group();
  const matLine = applyFisheye(new THREE.LineBasicMaterial({ color: 0x9966dd }));
  const matHair = applyFisheye(new THREE.LineBasicMaterial({ color: 0x221133 }));

  // All geometry in poseGroup so it tilts as one unit:
  //   rotation.x = 0      → lying flat (flying)
  //   rotation.x = +PI/2  → standing upright (floating at rest)
  const pose = new THREE.Group();
  group.add(pose);
  group.userData.pose = pose;

  function addOvalLine(rx, rz, cx, cy, cz, n) {
    const v = [];
    for (let i = 0; i < n; i++) {
      const a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
      v.push(cx + rx * Math.cos(a0), cy, cz + rz * Math.sin(a0),
             cx + rx * Math.cos(a1), cy, cz + rz * Math.sin(a1));
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    pose.add(new THREE.LineSegments(g, matLine));
  }

  function addOvalFill(rx, rz, cx, cy, cz, n, color, opacity) {
    const pos = [cx, cy, cz];
    for (let i = 0; i < n; i++) {
      const a = i / n * Math.PI * 2;
      pos.push(cx + rx * Math.cos(a), cy, cz + rz * Math.sin(a));
    }
    const idx = [];
    for (let i = 1; i <= n; i++) idx.push(0, i, i === n ? 1 : i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    pose.add(new THREE.Mesh(g, applyFisheye(new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide,
    }))));
  }

  // Head (face up in XZ plane, centered at z = −0.50)
  addOvalFill(0.12, 0.10, 0, 0, -0.50, 12, 0xffccaa, 0.92);
  addOvalLine(0.12, 0.10, 0, 0, -0.50, 12);

  // Torso / dress body (shoulders → hips)
  addOvalFill(0.13, 0.24, 0, 0, -0.08, 14, 0xddeeff, 0.80);
  addOvalLine(0.13, 0.24, 0, 0, -0.08, 14);

  // Skirt hem: triangle fan from hip centre out behind the body
  const HEM = [
    [ 0.10,  0.16],  // right hip
    [ 0.38,  0.32],  // right outer
    [ 0.44,  0.52],  // right hem tip
    [ 0.14,  0.62],  // right back
    [ 0.00,  0.66],  // centre back
    [-0.14,  0.62],  // left back
    [-0.44,  0.52],  // left hem tip
    [-0.38,  0.32],  // left outer
    [-0.10,  0.16],  // left hip
  ];
  {
    const pos = [0, 0, 0.16];   // fan centre at hip midpoint (index 0)
    HEM.forEach(([x, z]) => pos.push(x, 0, z));
    const idx = [];
    for (let i = 1; i < HEM.length; i++) idx.push(0, i, i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const skirtFill = new THREE.Mesh(g, applyFisheye(new THREE.MeshBasicMaterial({
      color: 0xddeeff, transparent: true, opacity: 0.65, depthWrite: false, side: THREE.DoubleSide,
    })));
    skirtFill.userData.rest = Float32Array.from(pos);
    pose.add(skirtFill);
    group.userData.skirtFill = skirtFill;
  }
  // Hem outline
  {
    const v = [];
    for (let i = 0; i < HEM.length - 1; i++)
      v.push(HEM[i][0], 0, HEM[i][1], HEM[i + 1][0], 0, HEM[i + 1][1]);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    pose.add(new THREE.LineSegments(g, matLine));
  }

  // Arms: sub-groups so the controller can rotate them for pose transitions
  function buildArm(sx) {
    const g = new THREE.Group();
    g.position.set(sx * 0.13, 0, -0.25);    // shoulder joint
    const v = [
      0,           0, 0,      sx * 0.22,  0,  0.13,   // upper arm
      sx * 0.22,   0, 0.13,   sx * 0.18,  0,  0.32,   // forearm
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.add(new THREE.LineSegments(geo, matLine));
    return g;
  }
  const armR = buildArm( 1);
  const armL = buildArm(-1);
  pose.add(armR, armL);
  group.userData.armR = armR;
  group.userData.armL = armL;

  // Legs: sub-groups for pose animation
  function buildLeg(sx) {
    const g = new THREE.Group();
    g.position.set(sx * 0.07, 0, 0.17);     // hip joint
    const v = [
      0,           0, 0,      sx * 0.04,  0,  0.28,   // thigh
      sx * 0.04,   0, 0.28,   sx * 0.06,  0,  0.50,   // shin
    ];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.add(new THREE.LineSegments(geo, matLine));
    return g;
  }
  const legR = buildLeg( 1);
  const legL = buildLeg(-1);
  pose.add(legR, legL);
  group.userData.legR = legR;
  group.userData.legL = legL;

  // Hair: 9 strands flowing from the back of the head toward +Z (trailing when flying)
  const NHAIR = 9;
  const hairStrands = [];
  for (let h = 0; h < NHAIR; h++) {
    const lat = (h / (NHAIR - 1)) - 0.5;            // −0.5 (left) … +0.5 (right)
    const xS  = lat * 0.20;
    const zS  = -0.42;                               // back of head
    const xE  = lat * 0.38;
    const zE  = zS + 0.68 + Math.abs(lat) * 0.10;   // side strands slightly shorter
    const pts  = new Float32Array([
      xS,                   0, zS,
      xS * 0.6 + xE * 0.4,  0, zS + 0.22,
      xS * 0.1 + xE * 0.9,  0, zS + 0.48,
      xE,                   0, zE,
    ]);
    const geo    = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.slice(), 3));
    const strand = new THREE.Line(geo, matHair);
    strand.userData = { rest: pts, lat };
    pose.add(strand);
    hairStrands.push(strand);
  }
  group.userData.hairStrands = hairStrands;

  group.scale.setScalar(0.5);
  return group;
}

// Owns the girl's pose transitions and wind-ripple animation.
function createGirlController(mesh) {
  const pose        = mesh.userData.pose;
  const armR        = mesh.userData.armR;
  const armL        = mesh.userData.armL;
  const legR        = mesh.userData.legR;
  const hairStrands = mesh.userData.hairStrands;
  const skirtFill   = mesh.userData.skirtFill;

  let poseT = 0;   // 0 = upright float (rest), 1 = flat flight

  return {
    update(dt, now, ctx) {
      const speed = ctx.speed || 0;         // per-frame units from controls.getSpeed()
      poseT += ((speed > 0.15 ? 1 : 0) - poseT) * Math.min(dt * 2.5, 1);

      // Tilt the whole pose group between lying flat and standing upright
      pose.rotation.x = (Math.PI / 2) * (1 - poseT);

      // Arms: alongside body while flying → spread outward at rest
      const spread = (1 - poseT) * Math.PI * 0.40;
      armR.rotation.z = -spread;
      armL.rotation.z =  spread;

      // Right leg semi-folded at rest (kick forward), straight in flight
      legR.rotation.x = -(1 - poseT) * Math.PI / 4;

      // Hair wind ripple — travelling wave from root toward tip
      const t   = now * 0.001;
      const amp = 0.020 + 0.032 * poseT;
      for (const s of hairStrands) {
        const arr  = s.geometry.attributes.position.array;
        const rest = s.userData.rest;
        const lat  = s.userData.lat;
        for (let k = 0; k < arr.length; k += 3) {
          const zr   = rest[k + 2];
          const frac = Math.max(0, (zr - rest[2]) / 0.60);   // 0 at root, 1 at tip
          const ph   = t * 4.2 + zr * 2.1;
          arr[k]     = rest[k]     + Math.sin(ph)         * amp * frac * (0.5 + Math.abs(lat));
          arr[k + 1] = rest[k + 1] + Math.sin(ph + 1.1)  * amp * frac * 0.35;
          arr[k + 2] = rest[k + 2] + Math.sin(ph * 0.65) * amp * frac * 0.15;
        }
        s.geometry.attributes.position.needsUpdate = true;
      }

      // Skirt hem ripple
      if (skirtFill) {
        const arr  = skirtFill.geometry.attributes.position.array;
        const rest = skirtFill.userData.rest;
        const sa   = 0.010 + 0.018 * poseT;
        for (let k = 0; k < arr.length; k += 3) {
          const zr = rest[k + 2];
          arr[k]     = rest[k]     + Math.sin(t * 3.6 + zr * 1.9) * sa;
          arr[k + 2] = rest[k + 2] + Math.sin(t * 2.8 + zr * 2.4) * sa * 0.5;
        }
        skirtFill.geometry.attributes.position.needsUpdate = true;
      }
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
  girl: {
    id:   'girl',
    name: 'Girl',
    build: applyFisheye => buildGirlMesh(applyFisheye),
    createController: mesh => createGirlController(mesh),
  },
};

export const DEFAULT_CHARACTER = 'bird';
