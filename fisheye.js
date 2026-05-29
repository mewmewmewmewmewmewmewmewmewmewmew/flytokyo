// ─── Single-pass fisheye projection (shared by main.js and train.js) ──────────
// Every world vertex is reprojected through an equidistant fisheye in the vertex
// shader — ONE render pass, versus six for a cubemap. The uFish* uniform objects
// below are shared by reference across every material, so flipping uFishOn.value
// switches the whole scene at once. Long edges are tessellated by the geometry
// builders so they curve smoothly instead of staying straight between two warped
// endpoints.

export const FISH_FOV_DEG  = 220;                                 // total fisheye angle
export const FISH_HALF_FOV = (FISH_FOV_DEG * Math.PI / 180) / 2;

export const FISH_U = {
  uFishOn:      { value: 0 },
  uFishHalfFov: { value: FISH_HALF_FOV },
  uFishAspect:  { value: 1 },        // viewport width / height
  uFishNear:    { value: 0.15 },
  uFishFar:     { value: 2000 },
};

// Return the SAME shared {value} objects so all materials stay in sync.
export function fishUniforms() {
  return {
    uFishOn: FISH_U.uFishOn, uFishHalfFov: FISH_U.uFishHalfFov,
    uFishAspect: FISH_U.uFishAspect, uFishNear: FISH_U.uFishNear, uFishFar: FISH_U.uFishFar,
  };
}

// Vertex side: declares the uniforms, the view-space position varying used by the
// fragment FOV clip, and projectVertex(). Set vFishView = mv.xyz in each main().
export const FISH_PROJ_GLSL = /* glsl */`
  uniform float uFishOn;
  uniform float uFishHalfFov;
  uniform float uFishAspect;
  uniform float uFishNear;
  uniform float uFishFar;
  varying vec3  vFishView;
  // View-space position → clip space. Normal projection when off; equidistant
  // full-frame fisheye when on (in view space the camera looks down −Z).
  vec4 projectVertex(vec4 mv) {
    if (uFishOn < 0.5) return projectionMatrix * mv;
    vec3  d     = mv.xyz;
    float len   = length(d);
    float theta = acos(clamp(-d.z / max(len, 1e-4), -1.0, 1.0));  // angle off forward
    float phi   = atan(d.y, d.x);
    float r     = theta / uFishHalfFov;                           // 0 centre … 1 at FOV edge
    float a     = uFishAspect;
    float s     = sqrt(1.0 + 1.0 / (a * a));                      // scale so corners are covered
    vec2  xy    = s * r * vec2(cos(phi), a * sin(phi));           // circular in pixels, fills frame
    float zc    = clamp((len - uFishNear) / (uFishFar - uFishNear), 0.0, 1.0) * 2.0 - 1.0;
    return vec4(xy, zc, 1.0);
  }
`;

// Fragment side: discard anything beyond the fisheye field of view. Big flat
// geometry (ground, road/river decals) can produce triangles that straddle the
// FOV edge or wrap behind the camera; the warp interpolates them as straight
// chords that smear across the screen. Recomputing the angle per-fragment and
// discarding past the FOV removes those smears. Call fishClip() first in main().
export const FISH_FRAG_GLSL = /* glsl */`
  uniform float uFishOn;
  uniform float uFishHalfFov;
  varying vec3  vFishView;
  void fishClip() {
    if (uFishOn < 0.5) return;
    float L     = length(vFishView);
    float theta = acos(clamp(-vFishView.z / max(L, 1e-4), -1.0, 1.0));
    if (theta > uFishHalfFov) discard;
  }
`;
