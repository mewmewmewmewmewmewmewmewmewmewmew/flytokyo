// ─── Single-pass fisheye projection (shared by main.js and train.js) ──────────
// Every world vertex is reprojected through an equidistant fisheye in the vertex
// shader — ONE render pass, versus six for a cubemap. The uFish* uniform objects
// below are shared by reference across every material, so updating them switches
// the whole scene at once. Long edges are tessellated by the geometry builders so
// they curve smoothly instead of staying straight between two warped endpoints.
//
// The effect is SPEED-DRIVEN: uFishBlend morphs the projection from a normal
// perspective view (blend 0, at rest) to a full equidistant fisheye (blend 1, at
// top speed), and uFishHalfFov grows the angle as you go faster.

export const FISH_FOV_DEG  = 220;                                 // fisheye angle at top (non-sprint) speed
export const FISH_HALF_FOV = (FISH_FOV_DEG * Math.PI / 180) / 2;

export const FISH_U = {
  uFishOn:      { value: 0 },        // master enable (F3): 0 = effect fully off
  uFishBlend:   { value: 0 },        // 0 = perspective (rest) … 1 = full fisheye (top speed)
  uFishHalfFov: { value: FISH_HALF_FOV },
  uFishAspect:  { value: 1 },        // viewport width / height
  uFishNear:    { value: 0.15 },
  uFishFar:     { value: 2000 },
  uFishZoom:    { value: 1 },        // radial magnification: 1 = none (rest) … >1 = zoomed in
};

// Return the SAME shared {value} objects so all materials stay in sync.
export function fishUniforms() {
  return {
    uFishOn: FISH_U.uFishOn, uFishBlend: FISH_U.uFishBlend, uFishHalfFov: FISH_U.uFishHalfFov,
    uFishAspect: FISH_U.uFishAspect, uFishNear: FISH_U.uFishNear, uFishFar: FISH_U.uFishFar,
    uFishZoom: FISH_U.uFishZoom,
  };
}

// Vertex side: declares the uniforms, the view-space position varying used by the
// fragment FOV clip, and projectVertex(). Set vFishView = mv.xyz in each main().
// At uFishBlend 0 it returns the plain perspective projection (identical to the
// "fisheye off" default); at blend 1 it returns the full equidistant fisheye; in
// between it lerps the two in NDC space so the warp eases in with speed.
// Unified RADIAL projection. Both the flat (perspective) and the fisheye view are
// expressed as a single radius R along the SAME phi ray, and morphing between them
// just slides each vertex in/out along its own ray — so there is no sideways jump
// and, crucially, no perspective-divide singularity (the old artifact source). The
// perspective radius is reconstructed from the camera's own projectionMatrix so
// blend=0 reproduces the standard view's framing exactly; the fisheye radius is the
// equidistant r∝theta, which is finite and well-behaved at every angle out to 180°.
export const FISH_PROJ_GLSL = /* glsl */`
  uniform float uFishOn;
  uniform float uFishBlend;
  uniform float uFishHalfFov;
  uniform float uFishAspect;
  uniform float uFishNear;
  uniform float uFishFar;
  uniform float uFishZoom;
  varying vec3  vFishView;
  vec4 projectVertex(vec4 mv) {
    vec3  d     = mv.xyz;
    float len   = length(d);
    float theta = acos(clamp(-d.z / max(len, 1e-4), -1.0, 1.0));   // 0 fwd … PI directly behind
    float phi   = atan(d.y, d.x);

    // Pull the exact vertical FOV + aspect from the live projection matrix so the
    // flat end matches the perspective camera (and adapts on resize / FOV change).
    float tanHalfP = 1.0 / projectionMatrix[1][1];
    float aspect   = projectionMatrix[1][1] / projectionMatrix[0][0];

    // Perspective radius (gnomonic, r ∝ tanθ) is only meaningful for θ < ~89°. Past
    // that, tan() is clamped — so EVERY far/behind-hemisphere vert (θ ≥ 89°) piles
    // onto the same radius and tears into a "fold ring" at a constant angle around
    // the view axis. That ring sits off-screen at rest (perspective shoves it past
    // the frame) but slides inward into view as the fisheye widens with speed.
    // Cure: ramp the blend to FULL fisheye as θ nears the horizon, so the clamped
    // Rp carries zero weight there and R is the pure equidistant Rf (finite, smooth
    // all the way to 180° — no fold). The ramp band (74°–89°) is off-screen in the
    // resting perspective view, so blend≈0 still frames exactly like the flat cam.
    const float TC = 1.5533;                          // ~89°, just under tan()'s blow-up
    // Gate the horizon ramp by the master enable: with the effect OFF (uFishOn 0)
    // it must contribute nothing so the projection is plain perspective everywhere
    // (no residual edge warp). With the effect ON it's ×1 — identical to before.
    float horizonFish = smoothstep(1.30, TC, theta) * uFishOn;  // 0 below ~74° … 1 by ~89°
    float b  = max(uFishBlend, horizonFish);
    // The sqrt(aspect²+1) factor reproduces the original fisheye's corner-fill
    // framing (matches the old s·a scaling) so the full-blend look is unchanged.
    float Rp = tan(min(theta, TC)) / tanHalfP;
    float Rf = sqrt(aspect * aspect + 1.0) * theta / uFishHalfFov;
    float R  = mix(Rp, Rf, b);
    // Radial magnification: as the fisheye widens with speed the broken outer
    // periphery (where the ground depth saturates and paints over the roads in a
    // ring) is scaled OUT past the frame edge and clipped away, so only the clean
    // central cone fills the screen. uFishZoom = 1 at rest leaves framing intact.
    vec2  ndc = vec2(R * cos(phi) / aspect, R * sin(phi)) * uFishZoom;

    // LINEAR depth by true view distance — monotonic with uniform precision across
    // the whole frame. Perspective depth (pc.z/pc.w) crushes far-away depth gaps to
    // nothing, so at the grazing angles of the fisheye periphery the thin ~0.6 m
    // ground↓/road↑ gap collapsed to a tie and the ground (drawn first) out-sorted
    // the road/river decals into a constant-radius ring. With linear depth that gap
    // stays resolvable at EVERY distance, so the ground can never paint over the
    // roads — at the periphery or anywhere. Behind-camera verts fall through the
    // same formula cleanly (no perspective-divide branch needed).
    float zc = clamp((len - uFishNear) / (uFishFar - uFishNear), 0.0, 1.0) * 2.0 - 1.0;

    // w = 1 throughout: the GPU clips x/y/z in [-1,1] with no divide, so there is no
    // singularity to blow up. Fine geometry is already tessellated, so dropping
    // perspective-correct varying interpolation is imperceptible.
    return vec4(ndc, zc, 1.0);
  }
`;

// Fragment side: discard anything beyond the (blended) fisheye field of view. Big
// flat geometry (ground, road/river decals) can produce triangles that straddle
// the FOV edge or wrap behind the camera; the warp interpolates them as straight
// chords that smear across the screen. Recomputing the angle per-fragment and
// discarding past the FOV removes those smears. The clip angle widens to ~180°
// as blend → 0 so a near-perspective (low-speed) view is never cropped into a
// circle. Call fishClip() first in main().
export const FISH_FRAG_GLSL = /* glsl */`
  uniform float uFishBlend;
  uniform float uFishHalfFov;
  varying vec3  vFishView;
  void fishClip() {
    float L     = length(vFishView);
    float theta = acos(clamp(-vFishView.z / max(L, 1e-4), -1.0, 1.0));
    if (vFishView.z > 0.0) {
      // Behind the camera plane (theta > 90°). Under the unified w=1 projection the
      // GPU no longer near-plane clips these, so we must: bound them by the true FOV
      // (half-FOV < 90° at low speed) so the ground hemisphere behind the camera
      // can't smear across the frame edge. Only once the FOV opens past 180° does
      // any of this hemisphere legitimately appear as the fisheye periphery.
      if (theta > uFishHalfFov) discard;
    } else {
      // In front of the camera: widen the clip toward ~180° as blend → 0 so the
      // flat (low-speed) view is never cropped into a circle.
      float clipAng = mix(3.14159, uFishHalfFov, uFishBlend);
      if (theta > clipAng) discard;
    }
  }
`;

// ─── Anime cel / toon shading (shared by buildings + trains) ──────────────────
// Quantises the diffuse term into a few flat bands instead of a smooth gradient,
// so surfaces read as painted cels rather than photoreal lit faces. A cool-tinted
// rim term adds the bright edge sheen typical of anime character/prop rendering.
// N, V, L are unit vectors in VIEW space (V = normalize(-vFishView) = toward eye).
export const TOON_GLSL = /* glsl */`
  vec3 celShade(vec3 base, vec3 N, vec3 V, vec3 L) {
    // Half-Lambert wrap keeps shadow sides readable, then snap to 3 flat bands
    // with anti-aliased steps so the cel boundaries don't shimmer at distance.
    float d    = dot(N, L) * 0.5 + 0.5;
    float band = 0.55
               + 0.22 * smoothstep(0.46, 0.50, d)
               + 0.23 * smoothstep(0.72, 0.76, d);
    vec3  col  = base * band;
    // Rim light: bright cool edge where the surface turns away from the eye.
    float rim  = pow(1.0 - max(dot(N, V), 0.0), 3.5);
    col += vec3(0.34, 0.40, 0.52) * rim * 0.6;
    return col;
  }
`;
