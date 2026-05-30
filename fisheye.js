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
};

// Return the SAME shared {value} objects so all materials stay in sync.
export function fishUniforms() {
  return {
    uFishOn: FISH_U.uFishOn, uFishBlend: FISH_U.uFishBlend, uFishHalfFov: FISH_U.uFishHalfFov,
    uFishAspect: FISH_U.uFishAspect, uFishNear: FISH_U.uFishNear, uFishFar: FISH_U.uFishFar,
  };
}

// Vertex side: declares the uniforms, the view-space position varying used by the
// fragment FOV clip, and projectVertex(). Set vFishView = mv.xyz in each main().
// At uFishBlend 0 it returns the plain perspective projection (identical to the
// "fisheye off" default); at blend 1 it returns the full equidistant fisheye; in
// between it lerps the two in NDC space so the warp eases in with speed.
export const FISH_PROJ_GLSL = /* glsl */`
  uniform float uFishBlend;
  uniform float uFishHalfFov;
  uniform float uFishAspect;
  uniform float uFishNear;
  uniform float uFishFar;
  varying vec3  vFishView;
  vec4 projectVertex(vec4 mv) {
    vec4 persp = projectionMatrix * mv;
    if (uFishBlend < 0.001) return persp;                          // rest → plain perspective

    vec3  d     = mv.xyz;
    float len   = length(d);
    float theta = acos(clamp(-d.z / max(len, 1e-4), -1.0, 1.0));   // angle off forward
    float phi   = atan(d.y, d.x);
    float r     = theta / uFishHalfFov;                            // 0 centre … 1 at FOV edge
    float a     = uFishAspect;
    float s     = sqrt(1.0 + 1.0 / (a * a));                       // scale so corners are covered
    vec2  xy    = s * r * vec2(cos(phi), a * sin(phi));            // circular in pixels, fills frame
    float zc    = clamp((len - uFishNear) / (uFishFar - uFishNear), 0.0, 1.0) * 2.0 - 1.0;
    vec4  fish  = vec4(xy, zc, 1.0);

    if (uFishBlend > 0.999) return fish;                           // top speed → full fisheye

    // Behind the near plane (theta > 90°): perspective NDC is garbage here, and
    // snapping straight to the fisheye position would stretch huge un-clipped
    // triangles across the screen at the slightest blend. Instead carry the
    // perspective w so the GPU keeps near-clipping these verts while the warp is
    // weak, then ease them into their true fisheye periphery as blend → 1.
    if (persp.w <= 0.0) {
      float wb = mix(persp.w, 1.0, uFishBlend);                    // ≤0 at low blend (clipped) → 1 at full
      return vec4(fish.xyz * wb, wb);
    }

    // In front of the camera: blend the two projections in normalised device coords.
    vec3 pndc = persp.xyz / persp.w;
    vec3 ndc  = mix(pndc, fish.xyz, uFishBlend);
    return vec4(ndc, 1.0);
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
    if (uFishBlend < 0.001) return;          // pure perspective: no clipping at all
    float L     = length(vFishView);
    float theta = acos(clamp(-vFishView.z / max(L, 1e-4), -1.0, 1.0));
    if (vFishView.z > 0.0) {
      // Behind the camera plane (theta > 90°). During acceleration the FOV is
      // still < 180° (half-FOV < 90°), so this whole hemisphere must be bounded
      // by the TRUE FOV — otherwise huge flat triangles (the ground) stretch
      // across the screen as grey smears. Only once the FOV opens past 180° does
      // any of it legitimately appear as the fisheye periphery.
      if (theta > uFishHalfFov) discard;
    } else {
      // In front of the camera: widen the clip toward ~180° as blend → 0 so a
      // near-perspective (low-speed) view is never cropped into a circle.
      float clipAng = mix(3.14159, uFishHalfFov, uFishBlend);
      if (theta > clipAng) discard;
    }
  }
`;
