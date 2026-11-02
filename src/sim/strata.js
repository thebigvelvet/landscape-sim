// Rock layers (Colorado Plateau stack): flat-lying beds of hard sandstone and soft shale, repeated
// downward from the top of the starting terrain. Rock type is worked out from a cell's bedrock
// elevation, so no extra buffer is needed and every cut reveals the next bed down.
//
// Each bed sets how fast running water wears the rock (erode), how fast it breaks down into soil
// (weather) and how steep a face it can hold before it falls (cliffTan). Hard sandstone over soft
// shale then erodes into cliffs above slopes, benches, mesas and buttes on its own.
//
// The same WGSL is used by the simulation kernels and the renderer, so the colours drawn are the
// beds the erosion is actually working on. Mirrored on the CPU by strataLayer() for tests.

// Top to bottom; the stack repeats below the last bed. Thickness in metres at strataScale 1.
export const STRATA = [
  { name: 'Caprock sandstone', thick: 14, erode: 0.25, weather: 0.3, cliffTan: 4.0, color: [0.88, 0.80, 0.64] },
  { name: 'Red shale', thick: 24, erode: 3.0, weather: 2.5, cliffTan: 0.9, color: [0.62, 0.30, 0.22] },
  { name: 'Massive sandstone', thick: 32, erode: 0.3, weather: 0.4, cliffTan: 3.5, color: [0.82, 0.52, 0.33] },
  { name: 'Gray shale', thick: 20, erode: 3.0, weather: 2.5, cliffTan: 0.9, color: [0.56, 0.55, 0.50] },
];
const CYCLE = STRATA.reduce((s, l) => s + l.thick, 0);
const f = (v) => v.toFixed(4);
const arr = (k) => `array<f32, ${STRATA.length}>(${STRATA.map((l) => f(l[k])).join(', ')})`;

// Needs nothing from the caller's bindings: top (m, same frame as bedrock), scale, and the grid
// cell (x, y in cells) for the gentle warp of the bed boundaries.
export const STRATA_WGSL = /* wgsl */`
fn stHash(p : vec2<f32>) -> f32 {
  let q = fract(p * vec2<f32>(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
fn stNoise(p : vec2<f32>) -> f32 {
  let i = floor(p); let u = fract(p); let s = u * u * (3.0 - 2.0 * u);
  return mix(mix(stHash(i), stHash(i + vec2<f32>(1.0, 0.0)), s.x),
             mix(stHash(i + vec2<f32>(0.0, 1.0)), stHash(i + vec2<f32>(1.0, 1.0)), s.x), s.y);
}
// (bed index, metres below the bed's top, metres above its base), all at true scale.
fn stLayer(z : f32, g : vec2<f32>, top : f32, scale : f32) -> vec3<f32> {
  var th = ${arr('thick')};
  let warp = (stNoise(g * 0.012) - 0.5) * 16.0 + (stNoise(g * 0.05) - 0.5) * 3.0;
  let d = (top - z + warp) / scale;
  let t = d - floor(d / ${f(CYCLE)}) * ${f(CYCLE)};
  var k = 0u; var b = 0.0;
  for (var j = 0u; j < ${STRATA.length - 1}u; j++) {
    if (t < b + th[k]) { break; }
    b += th[k]; k++;
  }
  return vec3<f32>(f32(k), (t - b) * scale, (b + th[k] - t) * scale);
}
// (erode multiplier, weather multiplier, cliff tan) with a ~1 m blend across each contact.
fn stProps(z : f32, g : vec2<f32>, top : f32, scale : f32) -> vec3<f32> {
  var er = ${arr('erode')};
  var we = ${arr('weather')};
  var ct = ${arr('cliffTan')};
  let L = stLayer(z, g, top, scale);
  let k = u32(L.x); let n = ${STRATA.length}u;
  let kd = (k + 1u) % n; let ku = (k + n - 1u) % n;
  let p = vec3<f32>(er[k], we[k], ct[k]);
  let pd = vec3<f32>(er[kd], we[kd], ct[kd]);
  let pu = vec3<f32>(er[ku], we[ku], ct[ku]);
  let toDown = 0.5 * (1.0 - smoothstep(0.0, 1.0, L.z));
  let toUp = 0.5 * (1.0 - smoothstep(0.0, 1.0, L.y));
  return p + (pd - p) * toDown + (pu - p) * toUp;
}
`;

// Renderer only: bed colour (sRGB) by bed index.
export const STRATA_COLOR_WGSL = /* wgsl */`
fn stColor(k : u32) -> vec3<f32> {
  var c = array<vec3<f32>, ${STRATA.length}>(${STRATA.map((l) => `vec3<f32>(${l.color.map(f).join(', ')})`).join(', ')});
  return c[k];
}
`;

// CPU mirror of stLayer (bed index only), for tests and probes.
export function strataLayer(z, x, y, top, scale = 1) {
  const hash = (px, py) => {
    let qx = px * 0.1031, qy = py * 0.1030; qx -= Math.floor(qx); qy -= Math.floor(qy);
    const d = qx * (qy + 33.33) + qy * (qx + 33.33);
    const rx = qx + d, ry = qy + d;
    const v = (rx + ry) * rx; return v - Math.floor(v);
  };
  const noise = (px, py) => {
    const ix = Math.floor(px), iy = Math.floor(py), ux = px - ix, uy = py - iy;
    const sx = ux * ux * (3 - 2 * ux), sy = uy * uy * (3 - 2 * uy);
    const a = hash(ix, iy) + (hash(ix + 1, iy) - hash(ix, iy)) * sx;
    const b = hash(ix, iy + 1) + (hash(ix + 1, iy + 1) - hash(ix, iy + 1)) * sx;
    return a + (b - a) * sy;
  };
  const warp = (noise(x * 0.012, y * 0.012) - 0.5) * 16 + (noise(x * 0.05, y * 0.05) - 0.5) * 3;
  const d = (top - z + warp) / scale;
  const t = d - Math.floor(d / CYCLE) * CYCLE;
  let b = 0, k = 0;
  while (k < STRATA.length - 1 && t >= b + STRATA[k].thick) { b += STRATA[k].thick; k++; }
  return k;
}
