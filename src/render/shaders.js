import { strataWGSL, MAX_BEDS } from '../sim/strata.js';
// WGSL for the renderer: shared uniforms, sky, terrain, terrain block sides, water, falling precipitation.

export const UNIFORMS = /* wgsl */ `
struct R {
  viewProj: mat4x4f,
  invViewProj: mat4x4f,
  camPos: vec4f,      // xyz, w = time (s)
  sunDir: vec4f,      // xyz to sun, w = sun intensity
  sunColor: vec4f,    // rgb, w = vertical exaggeration
  skyZenith: vec4f,   // rgb, w = overlay mode
  skyHorizon: vec4f,  // rgb, w = haze density (1/m)
  grid: vec4f,        // N, dx, base elevation (m), annual mean sea-level temp
  rock: vec4f,        // rgb, w = strata banding strength
  rock2: vec4f,       // rgb, w = vegetation amount
  soilC: vec4f,       // rgb, w = lapse rate (C/km)
  talus: vec4f,       // rgb, w = season phase 0..1 (0 = Jan 1)
  veg: vec4f,         // rgb, w = cloudiness 0..1
  sand: vec4f,        // rgb, w = precipitation intensity 0..1
  misc: vec4f,        // x = precip is snow (0..1), y = map extent (m), z = min height, w = show grid lines
  // ---- round 2: plants, events and the brush ----
  cursor: vec4f,      // brush ring: world x, world z, radius (m), tool (0 none, 1 storm, 2 drought, 3 flood, 4 fire)
  ripple: vec4f,      // click ripple: world x, world z, radius (m), age 0..1 (>= 1 none)
  ripCol: vec4f,      // ripple colour (display space), w = tool
  misc2: vec4f,       // x = drought look 0..1, y = seasonal temperature amplitude, z = lightning flash, w = tree scale
  forest: vec4f,      // x = conifer share, y = autumn colour (0 gold aspen .. 1 red maple), z = shrub (pinyon-juniper) share, w = groundwater capacity scale
  camRight: vec4f,    // camera right vector (world), w = unused
  camUp: vec4f,       // camera up vector (world)
  mk: array<vec4f, 4>,   // event markers on the ground: world x, world z, radius (m), kind (1 storm, 2 drought, 3 flood, 4 fire)
  mkA: vec4f,         // marker opacity 0..1
  st: array<vec4f, 4>,   // active storm clouds: world x, world z, radius (m), strength 0..1
  stX: vec4f,         // x = cloud base height (world y), y = snow 0..1, z = flash 0..1, w = cloud top height
  view: vec4f,        // viewport width, height (px), projection scale (P11), tree density scale
  // rock layers (sim/strata.js): 16 structure floats in packStrata order, bed table, bed colours
  stS: array<vec4f, 4>,
  stBeds: array<vec4f, ${MAX_BEDS}>,
  stCol: array<vec4f, ${MAX_BEDS}>,
};
@group(0) @binding(0) var<uniform> R_: R;
`;

const STRATA_R = strataWGSL((i) => `R_.stS[${i >> 2}].${'xyzw'[i & 3]}`, (k) => `R_.stBeds[${k}]`);
export const COMMON = STRATA_R + /* wgsl */ `
// Rock colour from the simulated beds at bedrock height z, grid cell g (linear rgb); a = 0 when off.
fn strataRock(z: f32, g: vec2f) -> vec4f {
  if (R_.stS[0].x < 0.5) { return vec4f(0.0); }
  let L = stLayer(z, g);
  let k = u32(L.x);
  // the contact itself shows as a slightly darker seam
  let seam = 1.0 - 0.25 * (1.0 - smoothstep(0.0, 0.8, min(L.y, L.z)));
  return vec4f(srgb(R_.stCol[k].rgb) * seam, 1.0);
}
fn srgb(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }
// Sediment bed colour (linear rgb) from its grain (0 clay, 0.33 silt, 0.66 sand, 1 gravel) and a
// per-bed hash h (0..1) that shades neighbouring beds apart, so a cut bank reads as bands.
fn bedColor(grain: f32, h: f32) -> vec3f {
  let clay = srgb(vec3f(0.60, 0.63, 0.58));
  let silt = srgb(vec3f(0.72, 0.63, 0.48));
  let sand = R_.sand.rgb;
  let grav = srgb(vec3f(0.52, 0.47, 0.41));
  var c = mix(clay, silt, smoothstep(0.08, 0.33, grain));
  c = mix(c, sand, smoothstep(0.4, 0.66, grain));
  c = mix(c, grav, smoothstep(0.72, 0.95, grain));
  // each bed a little lighter or darker and warmer or cooler than its neighbours, as real beds are
  let warm = fract(h * 7.31);
  return c * (0.78 + 0.44 * h) * mix(vec3f(1.06, 1.0, 0.92), vec3f(0.94, 1.0, 1.07), warm);
}
fn bedHash(epoch: f32) -> f32 { return fract(sin(epoch * 12.9898 + 4.1) * 43758.547); }
fn hash2(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.1030));
  let r = q + dot(q, q.yx + 33.33);
  return fract((r.x + r.y) * r.x);
}
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}
fn fbm(p: vec2f) -> f32 {
  var s = 0.0; var a = 0.5; var q = p;
  for (var k = 0; k < 5; k++) { s += a * vnoise(q); q = q * 2.03 + vec2f(17.1, 3.7); a *= 0.5; }
  return s;
}
fn skyColor(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  let up = clamp(d.y, -0.2, 1.0);
  let t = pow(clamp(up, 0.0, 1.0), 0.55);
  var c = mix(R_.skyHorizon.rgb, R_.skyZenith.rgb, t);
  if (up < 0.0) { c = mix(R_.skyHorizon.rgb, R_.skyHorizon.rgb * 0.75, clamp(-up * 5.0, 0.0, 1.0)); }
  let sd = max(dot(d, normalize(R_.sunDir.xyz)), 0.0);
  let cloud = R_.veg.w;
  c += R_.sunColor.rgb * (pow(sd, 8.0) * 0.25 + pow(sd, 64.0) * 0.5) * (1.0 - cloud * 0.8);
  return c;
}
fn hazeColor(viewDir: vec3f) -> vec3f {
  let sd = max(dot(normalize(viewDir), normalize(R_.sunDir.xyz)), 0.0);
  return mix(R_.skyHorizon.rgb, R_.skyHorizon.rgb + R_.sunColor.rgb * 0.25, pow(sd, 6.0));
}
fn applyHaze(col: vec3f, wpos: vec3f) -> vec3f {
  let v = wpos - R_.camPos.xyz;
  let d = length(v);
  let hFall = exp(-max(wpos.y - R_.misc.z * R_.sunColor.w, 0.0) / 2500.0);
  let f = 1.0 - exp(-d * R_.skyHorizon.w * (0.35 + 0.65 * hFall));
  return mix(col, hazeColor(v), clamp(f, 0.0, 0.85));
}
fn springDecode(c: f32) -> f32 { return select(0.0, 1e-5 * pow(10.0, 5.0 * c), c > 0.0); }
fn toolColor(t: f32) -> vec3f {
  if (t < 1.5) { return vec3f(0.35, 0.70, 1.0); }      // storm: blue
  if (t < 2.5) { return vec3f(1.0, 0.72, 0.25); }      // drought: amber
  if (t < 3.5) { return vec3f(0.20, 0.95, 0.95); }     // flood: cyan
  if (t < 4.5) { return vec3f(1.0, 0.38, 0.12); }      // fire: orange
  return vec3f(0.95, 0.95, 0.88);                      // sculpt tools: chalk white
}
// Voronoi edge distance (cracked mud)
fn crackDist(p: vec2f) -> f32 {
  let ip = floor(p); let fp = fract(p);
  var d1 = 8.0; var d2 = 8.0;
  for (var j = -1; j <= 1; j++) {
    for (var i = -1; i <= 1; i++) {
      let g = vec2f(f32(i), f32(j));
      let o = vec2f(hash2(ip + g), hash2(ip + g + 17.3));
      let d = length(g + o - fp);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
  }
  return d2 - d1;
}
// Annual mean air temperature at an absolute elevation (lapse rate from the preset).
fn tMeanAt(elevAbs: f32) -> f32 { return R_.grid.w - R_.soilC.w * elevAbs / 1000.0; }
// Air temperature now (season phase R_.talus.w, peak late July).
fn tNowAt(elevAbs: f32) -> f32 { return tMeanAt(elevAbs) + R_.misc2.y * cos(6.2831853 * (R_.talus.w - 200.0 / 365.0)); }
// Leaf colour of broadleaf trees (aspen / maple) through the year at this elevation.
fn leafColor(elevAbs: f32, h: f32, dry: f32) -> vec4f {
  let doy = R_.talus.w * 365.0;
  let shift = clamp((tMeanAt(elevAbs) - 6.0) * 3.0, -25.0, 25.0);     // warmer: later autumn, earlier spring
  let aut0 = 252.0 + shift; let off = 300.0 + shift; let on = 135.0 - shift;
  let green = mix(srgb(vec3f(0.46, 0.62, 0.22)), srgb(vec3f(0.24, 0.40, 0.13)), smoothstep(on, on + 40.0, doy));
  let gold = srgb(mix(vec3f(0.86, 0.56, 0.08), vec3f(0.93, 0.70, 0.16), h));
  let red = srgb(mix(vec3f(0.86, 0.30, 0.08), vec3f(0.93, 0.55, 0.10), h));
  let autC = mix(gold, red, R_.forest.y * step(0.35, h));
  var c = green;
  c = mix(c, srgb(vec3f(0.62, 0.55, 0.25)), smoothstep(0.5, 0.9, dry) * 0.8);   // drought: leaves scorch
  c = mix(c, autC, smoothstep(aut0, aut0 + 18.0, doy));
  let bare = srgb(vec3f(0.40, 0.36, 0.34));
  let leafless = max(smoothstep(off - 6.0, off + 6.0, doy), 1.0 - smoothstep(on - 10.0, on + 4.0, doy));
  c = mix(c, bare, leafless);
  return vec4f(c, 1.0 - leafless);
}
fn tonemap(c: vec3f) -> vec3f {
  // ACES fitted curve + gamma for an sRGB-ish display.
  let a = c * 0.8;
  let m = (a * (2.51 * a + 0.03)) / (a * (2.43 * a + 0.59) + 0.14);
  return pow(clamp(m, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2));
}
`;

export const SKY = UNIFORMS + COMMON + /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) ndc: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.ndc = p[vi];
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let a = R_.invViewProj * vec4f(i.ndc, 0.0, 1.0);
  let b = R_.invViewProj * vec4f(i.ndc, 1.0, 1.0);
  let dir = normalize(b.xyz / b.w - a.xyz / a.w);
  var c = skyColor(dir);
  // Clouds: a soft layer that thickens with cloudiness.
  if (dir.y > 0.01) {
    let uv = dir.xz / (dir.y + 0.08) * 1.4 + vec2f(R_.camPos.w * 0.01, R_.camPos.w * 0.004);
    let n = fbm(uv * 1.3);
    let cov = mix(0.62, 0.30, R_.veg.w);
    let cl = smoothstep(cov, cov + 0.25, n) * smoothstep(0.01, 0.25, dir.y);
    let lit = mix(vec3f(1.0, 0.99, 0.97) * (0.9 + 0.3 * R_.sunDir.w), srgb(vec3f(0.55, 0.57, 0.62)), R_.veg.w);
    c = mix(c, lit, cl * 0.85);
  }
  return vec4f(tonemap(c), 1.0);
}`;

const TERRAIN_DATA = /* wgsl */ `
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
@group(0) @binding(3) var<storage, read> snowSWE: array<f32>;
@group(0) @binding(4) var<storage, read> water: array<f32>;
@group(0) @binding(5) var<storage, read> sediment: array<f32>;
@group(0) @binding(6) var<storage, read> frostDepth: array<f32>;
@group(0) @binding(7) var<storage, read> light: array<vec4u>;
@group(0) @binding(8) var<storage, read> height0: array<f32>;
@group(0) @binding(9) var<storage, read> windF: array<vec4f>;   // sim/wind.js: (.., .., local wind speed, shelter)
@group(0) @binding(10) var<storage, read> glacier: array<vec4f>; // sim/glacier.js: (ice m, debris m, speed m/yr, ..)
fn gi(x: i32, y: i32) -> u32 {
  let n = i32(R_.grid.x);
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn dispH(i: u32) -> f32 { return bedrock[i] + soil[i] + snowSWE[i] / 0.33 + glacier[i].x; }
`;

export const TERRAIN = UNIFORMS + COMMON + TERRAIN_DATA + /* wgsl */ `
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) m0: vec4f,   // soil, snowSWE, water, sediment
  @location(3) m1: vec4f,   // frost, sun visibility, ao, height change since start
  @location(4) m2: vec4f,   // ground height (m), grid x, grid y, ground slope (tan)
  @location(5) m3: vec2f,   // groundwater fill 0..1, spring discharge (m/day)
  @location(6) m4: vec4f,   // plant cover, woody share, burn, fire
  @location(7) m5: vec4f,   // moisture memory, sediment bed thickness (sqrt(t/16 m)), top bed grain, top bed hash
  @location(8) m6: vec2f,   // local wind speed, shelter (0 = in the lee), sim/wind.js
  @location(9) m7: vec4f,   // glacier ice thickness (m), debris (m), ice speed (m/yr), ice surface slope (tan)
};
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let n = u32(R_.grid.x);
  let x = i32(vi % n); let y = i32(vi / n);
  let i = vi;
  let dx = R_.grid.y;
  let vex = R_.sunColor.w;
  let c = (f32(n) - 1.0) * 0.5;
  let ground = bedrock[i] + soil[i];
  let hd = dispH(i);
  let hl = dispH(gi(x - 1, y)); let hr = dispH(gi(x + 1, y));
  let ht = dispH(gi(x, y - 1)); let hb = dispH(gi(x, y + 1));
  var o: VO;
  let wp = vec3f((f32(x) - c) * dx, hd * vex, (f32(y) - c) * dx);
  o.pos = R_.viewProj * vec4f(wp, 1.0);
  o.wpos = wp;
  o.nrm = normalize(vec3f((hl - hr) * vex, 2.0 * dx, (ht - hb) * vex));
  let gl = bedrock[gi(x - 1, y)] + soil[gi(x - 1, y)];
  let gr = bedrock[gi(x + 1, y)] + soil[gi(x + 1, y)];
  let gt = bedrock[gi(x, y - 1)] + soil[gi(x, y - 1)];
  let gb = bedrock[gi(x, y + 1)] + soil[gi(x, y + 1)];
  let gslope = length(vec2f(gr - gl, gb - gt)) / (2.0 * dx);
  o.m0 = vec4f(soil[i], snowSWE[i], water[i], sediment[i]);
  let L = light[i];
  let la = unpack2x16unorm(L.x);
  let lb = unpack2x16unorm(L.y);
  o.m1 = vec4f(frostDepth[i], la.x, la.y, ground - height0[i]);
  o.m2 = vec4f(ground, f32(x), f32(y), gslope);
  o.m3 = vec2f(lb.x, springDecode(lb.y));
  o.m4 = unpack4x8unorm(L.z);
  o.m5 = unpack4x8unorm(L.w);
  o.m6 = windF[i].zw;
  let gk = glacier[i];
  o.m7 = vec4f(gk.x, gk.y, gk.z, length(vec2f(hr - hl, hb - ht)) / (2.0 * dx));
  return o;
}

fn ramp3(t: f32, a: vec3f, b: vec3f, c: vec3f) -> vec3f {
  let s = clamp(t, 0.0, 1.0);
  if (s < 0.5) { return mix(a, b, s * 2.0); }
  return mix(b, c, s * 2.0 - 2.0 * 0.5);
}

// Overlay colour maps. Must match the legends drawn in src/ui/legend.js.
fn overlay(mode: i32, m0: vec4f, m1: vec4f, m3: vec2f, m4: vec4f, m5: vec4f, m6: vec2f, m7: vec4f) -> vec4f {
  if (mode == 10) { // glaciers: ice speed (log 1 .. 200 m/yr), pale where the ice is thin, rock debris brown
    let ice = m7.x;
    if (ice < 0.3) { return vec4f(0.0); }
    let t = clamp(log(1.0 + m7.z) / log(201.0), 0.0, 1.0);
    var c = ramp3(t, vec3f(0.80, 0.96, 1.0), vec3f(0.20, 0.55, 0.95), vec3f(0.55, 0.15, 0.70));
    c = mix(vec3f(0.92, 0.97, 1.0), c, smoothstep(1.0, 20.0, ice));
    c = mix(c, vec3f(0.50, 0.33, 0.20), smoothstep(0.3, 2.0, m7.y / (1.0 + ice / 5.0)) * 0.8);
    return vec4f(c, 0.9);
  }
  if (mode == 9) { // wind & sand: local wind speed, the sheltered lee hatched dark, wind-laid sand on top
    let u = m6.x;
    var c = ramp3(u / 2.0, vec3f(0.85, 0.92, 0.98), vec3f(0.35, 0.65, 0.95), vec3f(0.55, 0.15, 0.70));
    c = mix(c, vec3f(0.20, 0.24, 0.35), (1.0 - m6.y) * 0.75);
    let t = m5.y * m5.y * 16.0;
    let sandTop = smoothstep(0.45, 0.5, m5.z) * (1.0 - smoothstep(0.8, 0.85, m5.z)) * smoothstep(0.05, 0.5, t);
    c = mix(c, vec3f(0.98, 0.80, 0.30), sandTop * 0.7);
    return vec4f(c, 0.9);
  }
  if (mode == 8) { // sediment beds: top bed grain, stronger where the fill is thicker
    let t = m5.y * m5.y * 16.0;
    if (t < 0.01) { return vec4f(0.0); }
    let g = m5.z;
    var c = mix(vec3f(0.55, 0.70, 0.80), vec3f(0.90, 0.78, 0.50), smoothstep(0.08, 0.33, g));
    c = mix(c, vec3f(0.98, 0.88, 0.25), smoothstep(0.4, 0.66, g));
    c = mix(c, vec3f(0.55, 0.30, 0.15), smoothstep(0.72, 0.95, g));
    return vec4f(c * (0.9 + 0.2 * m5.w), 0.35 + 0.6 * smoothstep(0.01, 2.0, t));
  }
  if (mode == 7) { // plants: bare -> grass -> forest, recent burns in red
    let v = m4.x; let w = m4.y; let b = m4.z;
    var c = ramp3(v, vec3f(0.93, 0.86, 0.62), vec3f(0.62, 0.84, 0.32), vec3f(0.10, 0.48, 0.16));
    c = mix(c, vec3f(0.02, 0.26, 0.10), w * smoothstep(0.3, 0.8, v) * 0.75);
    var a = smoothstep(0.0, 0.08, v) * 0.85;
    if (b > 0.1) { c = mix(c, vec3f(0.80, 0.10, 0.08), smoothstep(0.1, 0.5, b)); a = 0.9; }
    if (m4.w > 0.05) { c = vec3f(1.0, 0.55, 0.05); a = 1.0; }
    return vec4f(c, a);
  }
  if (mode == 1) { // water depth, log 1 mm .. 10 m
    let d = m0.z;
    if (d < 0.001) { return vec4f(0.0); }
    let t = log(d / 0.001) / log(10000.0);
    return vec4f(ramp3(t, vec3f(0.70, 0.93, 1.0), vec3f(0.15, 0.55, 0.95), vec3f(0.04, 0.10, 0.45)), 0.85);
  }
  if (mode == 2) { // suspended sediment, log 0.1 mm .. 1 m
    let s = m0.w;
    if (s < 1e-4) { return vec4f(0.0); }
    let t = log(s / 1e-4) / log(10000.0);
    return vec4f(ramp3(t, vec3f(1.0, 0.92, 0.45), vec3f(0.95, 0.55, 0.12), vec3f(0.45, 0.18, 0.05)), 0.85);
  }
  if (mode == 3) { // snow water equivalent 0 .. 2 m
    let s = m0.y;
    if (s < 0.001) { return vec4f(0.0); }
    let t = sqrt(clamp(s / 2.0, 0.0, 1.0));
    return vec4f(ramp3(t, vec3f(0.85, 0.97, 1.0), vec3f(0.30, 0.65, 0.95), vec3f(0.40, 0.18, 0.70)), 0.85);
  }
  if (mode == 4) { // frozen ground depth 0 .. 2 m
    let f = m1.x;
    if (f < 0.01) { return vec4f(0.0); }
    let t = clamp(f / 2.0, 0.0, 1.0);
    return vec4f(ramp3(t, vec3f(0.85, 0.80, 1.0), vec3f(0.55, 0.40, 0.90), vec3f(0.22, 0.08, 0.45)), 0.85);
  }
  if (mode == 5) { // change since start, symmetric log, +-0.1 m .. +-50 m
    let d = m1.w;
    let t = sign(d) * log(1.0 + abs(d) / 0.1) / log(501.0);
    let a = smoothstep(0.03, 0.2, abs(t)) * 0.85;
    if (t < 0.0) { return vec4f(mix(vec3f(1.0, 0.85, 0.75), vec3f(0.70, 0.08, 0.10), clamp(-t, 0.0, 1.0)), a); }
    return vec4f(mix(vec3f(0.80, 0.88, 1.0), vec3f(0.08, 0.25, 0.75), clamp(t, 0.0, 1.0)), a);
  }
  if (mode == 6) { // groundwater fill 0..1, springs (log 0.1 mm/day .. 10 cm/day) on top
    let sp = m3.y;
    if (sp > 1e-4) {
      let t = clamp(log(sp / 1e-4) / log(1000.0), 0.0, 1.0);
      return vec4f(mix(vec3f(0.10, 1.0, 0.80), vec3f(0.0, 0.70, 0.45), t), 1.0);
    }
    // stretch 20%..80% full: the store rarely leaves that range, and the contrast is the story
    let g = clamp((m3.x - 0.2) / 0.6, 0.0, 1.0);
    return vec4f(ramp3(g, vec3f(0.93, 0.80, 0.55), vec3f(0.60, 0.75, 0.88), vec3f(0.10, 0.22, 0.62)), 0.85);
  }
  return vec4f(0.0);
}

@fragment fn fs(i: VO) -> @location(0) vec4f {
  let n = normalize(i.nrm);
  let wp = i.wpos;
  let p2 = wp.xz;
  let soilD = i.m0.x;
  let swe = i.m0.y;
  let wdep = i.m0.z;
  let ground = i.m2.x;
  let slopeTan = i.m2.w;
  let elevAbs = ground + R_.grid.z;
  let nz = fbm(p2 * 0.02);
  let nzf = vnoise(p2 * 0.25);

  // --- Rock: strata bands plus mottling.
  // Layers are nearly horizontal with gentle warping; thickness varies, so bands look like strata, not contours.
  let warp = vnoise(p2 * 0.0025) * 40.0 + nz * 12.0;
  let lay = ground + warp;
  let band = smoothstep(0.25, 0.75, sin(lay * 0.045 + 1.7 * sin(lay * 0.013)) * 0.5 + 0.5);
  let band2 = sin(lay * 0.21 + nz * 3.0) * 0.5 + 0.5;
  let bandStr = R_.rock.w * (0.6 + 0.4 * vnoise(p2 * 0.01));
  var rockC = mix(R_.rock.rgb, R_.rock2.rgb, clamp(band * bandStr + nz * (1.0 - R_.rock.w), 0.0, 1.0));
  // Real rock layers replace the painted bands: the colour is the bed the erosion is working on.
  let stc = strataRock(ground - soilD, i.m2.yz);
  rockC = mix(rockC, stc.rgb * (0.85 + 0.3 * nz), stc.a * 0.85);
  rockC = rockC * (0.8 + 0.3 * band2 * bandStr + 0.25 * (nzf - 0.5));
  // --- Loose material: talus on steep slopes, soil on gentle ground.
  let steep = smoothstep(0.35, 0.75, slopeTan);
  var looseC = mix(R_.soilC.rgb, R_.talus.rgb, steep);
  looseC = looseC * (0.9 + 0.2 * nzf);
  // Sediment beds laid down by the water (sim/deposits.js): the top bed's own colour - gravel bars
  // in channels, sand and silt on flats, clay in old ponds.
  let depM = i.m5.y * i.m5.y * 16.0;
  let gravelS = smoothstep(0.7, 1.0, i.m5.z) * (vnoise(p2 * 2.1) - 0.5) * 0.5;
  let bedC = bedColor(i.m5.z, i.m5.w) * (0.9 + 0.2 * nzf + gravelS);
  looseC = mix(looseC, bedC, smoothstep(0.02, 0.3, depM) * 0.85);
  // Loose sand (a sand top bed, e.g. a dune) shows faint wind ripples running across the wind.
  let sandTop = smoothstep(0.45, 0.5, i.m5.z) * (1.0 - smoothstep(0.8, 0.85, i.m5.z)) * smoothstep(0.05, 0.4, depM);
  let wdir = vec2f(R_.camRight.w, R_.camUp.w);
  let rip = sin(dot(p2, wdir) * 1.9 + 2.0 * vnoise(p2 * 0.3)) * 0.5 + 0.5;
  looseC = looseC * (1.0 + sandTop * (rip - 0.5) * 0.12);
  // Gravelly speckle so broad soil and talus areas are not flat colour.
  let grit = vnoise(p2 * 1.3) * 0.6 + vnoise(p2 * 3.7) * 0.4;
  looseC = looseC * (0.82 + 0.3 * grit);
  // ---- Plants, from the simulated layers (sim/vegetation.js) ----
  let veg = i.m4.x; let woody = i.m4.y; let burnS = i.m4.z; let fire = i.m4.w;
  let moist = i.m5.x;
  let dry = clamp(1.0 - moist * 1.25 + R_.misc2.x * 0.15, 0.0, 1.0);
  let tNow = tNowAt(elevAbs);
  let growing = smoothstep(1.0, 8.0, tNow);
  // Drought bakes bare soil: paler, with mud cracks on gentle ground.
  let bake = smoothstep(0.55, 0.9, dry) * (1.0 - steep) * smoothstep(0.05, 0.3, soilD);
  let crack = 1.0 - smoothstep(0.0, 0.06, crackDist(p2 * 0.45));
  looseC = mix(looseC, looseC * vec3f(1.28, 1.18, 1.02) + vec3f(0.03, 0.02, 0.0), bake * 0.75);
  looseC = looseC * (1.0 - crack * bake * 0.55);
  let rockExpo = 1.0 - smoothstep(0.03, 0.35, soilD + (nzf - 0.5) * 0.1);
  var albedo = mix(looseC, rockC, rockExpo);
  // Herbs and grass: green in the growing season, golden when dry, dormant tan in winter.
  let grassGreen = mix(R_.veg.rgb * vec3f(1.05, 1.2, 0.9), srgb(vec3f(0.29, 0.40, 0.16)), 0.5 * (1.0 - R_.forest.z));   // sage in the desert
  let straw = srgb(vec3f(0.74, 0.62, 0.35));
  let dormant = mix(srgb(vec3f(0.55, 0.45, 0.30)), srgb(vec3f(0.66, 0.54, 0.33)), vnoise(p2 * 0.05));
  var herb = mix(grassGreen, straw, smoothstep(0.35, 0.85, dry));
  herb = mix(dormant, herb, growing);
  // tufts: darker clumps and lighter seed heads so meadows have texture
  let tuft = vnoise(p2 * 0.6) * 0.6 + vnoise(p2 * 2.3) * 0.4;
  herb = herb * (0.70 + 0.55 * tuft);
  // Canopy seen from above (the 3D trees add relief up close): conifer, broadleaf or pinyon-juniper.
  let hcell = hash2(floor(p2 / 23.0));
  let coldBoost = clamp((-1.0 - tMeanAt(elevAbs)) * 0.15, -0.4, 0.5);
  let conShare = clamp(R_.forest.x + coldBoost, 0.0, 1.0);
  let conifer = mix(srgb(vec3f(0.11, 0.21, 0.12)), srgb(vec3f(0.40, 0.31, 0.16)), smoothstep(0.6, 0.95, dry));
  let leaf = leafColor(elevAbs, hcell, dry);
  let broad = mix(srgb(vec3f(0.30, 0.27, 0.24)), leaf.rgb, 0.35 + 0.65 * leaf.a);
  let pj = srgb(vec3f(0.24, 0.29, 0.18));
  var canopy = mix(broad, conifer, smoothstep(0.35, 0.65, conShare + (vnoise(p2 * 0.04) - 0.5) * 0.6));
  canopy = mix(canopy, pj, R_.forest.z * (1.0 - smoothstep(0.3, 0.7, moist)));
  canopy = canopy * (0.75 + 0.5 * vnoise(p2 * 0.35));
  let vegC = mix(herb, canopy, smoothstep(0.1, 0.7, woody));
  // Patchy cover: sparse plants read as clumps, not a tint.
  let patchN = vnoise(p2 * 0.22) * 0.55 + vnoise(p2 * 0.9) * 0.45;
  // (combined build: proportional, so sparse plants in rock cracks read as rock with green flecks)
  let cov = smoothstep(0.0, 0.45, veg * 1.1 - (patchN - 0.5) * 0.6 - 0.2) * smoothstep(0.0, 0.05, veg);
  albedo = mix(albedo, vegC, cov);
  // Burn scar: char with grey ash, fading to dark earth as it ages; green shoots come back on top.
  let ashN = vnoise(p2 * 0.8);
  let scar = mix(srgb(vec3f(0.07, 0.06, 0.055)), srgb(vec3f(0.42, 0.40, 0.38)), smoothstep(0.55, 0.85, ashN) * 0.7);
  let scarAmt = smoothstep(0.02, 0.35, burnS);
  albedo = mix(albedo, mix(albedo * 0.45, scar, smoothstep(0.25, 0.7, burnS)), scarAmt * (1.0 - cov * 0.75));

  // Wet ground darkens.
  let wet = max(smoothstep(0.0005, 0.02, wdep), smoothstep(1e-4, 2e-3, i.m3.y) * 0.7);
  albedo = albedo * (1.0 - 0.35 * wet);
  // Hoar frost on frozen bare ground.
  albedo = mix(albedo, srgb(vec3f(0.80, 0.84, 0.88)), smoothstep(0.05, 0.5, i.m1.x) * 0.18 * (1.0 - wet));

  // --- Glacier ice (sim/glacier.js): blue-white, bluer where thick, crevassed where it is fast and
  // steep, grey-brown where it carries a lot of rock (moraine stripes and debris-covered snouts).
  let ice = i.m7.x;
  let iceCov = smoothstep(0.3, 3.0, ice + (fbm(p2 * 0.04) - 0.5) * 3.0 + (nzf - 0.5) * 0.8);
  var iceC = mix(srgb(vec3f(0.80, 0.87, 0.92)), srgb(vec3f(0.55, 0.72, 0.86)), smoothstep(5.0, 120.0, ice));
  iceC = iceC * (0.93 + 0.1 * vnoise(p2 * vec2f(0.03, 0.09)));                       // foliation / dirt bands
  let crevAmt = smoothstep(10.0, 80.0, i.m7.z) * smoothstep(0.1, 0.35, i.m7.w);
  let crevN = abs(vnoise(p2 * vec2f(0.09, 0.025) + nz * 1.5) - 0.5);
  iceC = mix(iceC, srgb(vec3f(0.18, 0.33, 0.48)), crevAmt * (1.0 - smoothstep(0.02, 0.06, crevN)) * 0.8);
  // rock rides near the bed; it shows on the surface where the ice thins towards the snout
  let debS = smoothstep(0.3, 2.0, i.m7.y / (1.0 + ice / 5.0) + (vnoise(p2 * 0.2) - 0.5) * 0.4);
  iceC = mix(iceC, R_.talus.rgb * (0.7 + 0.3 * grit), debS * 0.85);
  albedo = mix(albedo, iceC, iceCov);

  // --- Snow with soft, noisy edges; thin snow shows rocks through on steep ground.
  let snowEdge = swe / 0.03 + (fbm(p2 * 0.05) - 0.5) * 1.2 - steep * 0.5;
  let snowCov = smoothstep(0.15, 1.0, snowEdge) * smoothstep(0.0002, 0.002, swe);
  let snowC = srgb(vec3f(0.93, 0.95, 0.98));
  albedo = mix(albedo, snowC, snowCov);

  // --- Lighting.
  let L = normalize(R_.sunDir.xyz);
  let sunVis = i.m1.y;
  let ao = mix(0.35, 1.0, i.m1.z);
  let ndl = max(dot(n, L), 0.0);
  let cloud = R_.veg.w;
  let sunI = R_.sunDir.w * (1.0 - 0.75 * cloud);
  var stormShade = 1.0;
  for (var k = 0; k < 4; k++) {
    let sv = R_.st[k];
    if (sv.w > 0.0) {
      let d = length(wp.xz - sv.xy) / max(sv.z, 1.0);
      stormShade = stormShade * (1.0 - 0.75 * sv.w * (1.0 - smoothstep(0.7, 1.6, d)));
    }
  }
  let direct = R_.sunColor.rgb * ndl * sunVis * sunI * 3.0 * stormShade;
  let skyAmb = mix(R_.skyHorizon.rgb, R_.skyZenith.rgb, 0.5 + 0.5 * n.y) * (0.45 + 0.45 * cloud);
  let bounce = albedo * albedo * 0.35 * (1.0 - n.y) * sunI;
  var col = albedo * (direct + skyAmb * ao * ao * 0.8 * mix(1.0, stormShade, 0.5)) + bounce * ao;
  col = col * (1.0 + R_.stX.z * 0.9 * (1.0 - stormShade));   // lightning lights up the ground under the cloud
  // Bluish fill in snow shadows; soft sparkle in sun.
  col += snowCov * vec3f(0.02, 0.05, 0.10) * (1.0 - sunVis) * ao;
  let V = normalize(R_.camPos.xyz - wp);
  let Hh = normalize(L + V);
  col += snowCov * R_.sunColor.rgb * pow(max(dot(n, Hh), 0.0), 60.0) * 0.25 * sunVis * sunI;
  // bare ice is glossy
  col += iceCov * (1.0 - snowCov) * (1.0 - debS) * R_.sunColor.rgb * pow(max(dot(n, Hh), 0.0), 30.0) * 0.18 * sunVis * sunI;

  col = applyHaze(col, wp);
  var outc = tonemap(col);
  // --- Overlay, blended in display space so colours match the legend.
  let ov = overlay(i32(R_.skyZenith.w), i.m0, i.m1, i.m3, i.m4, i.m5, i.m6, i.m7);
  if (i32(R_.skyZenith.w) > 0) {
    // Mute the natural colours so the overlay reads clearly.
    let g = dot(outc, vec3f(0.3, 0.55, 0.15));
    outc = mix(outc, vec3f(g) * 0.9 + 0.05, 0.6);
  }
  if (ov.a > 0.0) {
    let shade = 0.6 + 0.4 * (ndl * sunVis * 0.8 + 0.2) * ao;
    outc = mix(outc, ov.rgb * shade, ov.a);
  }
  // ---- Fire: glowing front, embers in the fresh scar ----
  let tt = R_.camPos.w;
  if (fire > 0.02) {
    let fl = vnoise(p2 * 0.09 + vec2f(tt * 0.9, -tt * 1.3)) * 0.6 + vnoise(p2 * 0.35 - vec2f(tt * 2.1, tt * 1.7)) * 0.4;
    let g = fire * (0.45 + 0.9 * fl);
    outc = outc * (1.0 - 0.55 * fire) + vec3f(1.0, 0.42, 0.07) * g * 1.25 + vec3f(1.0, 0.85, 0.4) * smoothstep(0.75, 1.0, fl) * fire;
  }
  if (burnS > 0.4 && fire < 0.5) {
    let em = smoothstep(0.93, 0.99, hash2(floor(p2 * 0.6))) * (0.5 + 0.5 * sin(tt * 3.0 + hash2(floor(p2 * 0.6)) * 30.0));
    outc += vec3f(1.0, 0.25, 0.03) * em * smoothstep(0.75, 1.0, burnS) * 0.8;
  }
  // ---- Event markers, brush cursor, click ripple (drawn on the ground) ----
  let px = max(fwidth(wp.x) + fwidth(wp.z), 0.5);
  for (var k = 0; k < 4; k++) {
    let m = R_.mk[k];
    let a = R_.mkA[k];
    if (a > 0.0) {
      let d = length(wp.xz - m.xy);
      let pulse = 0.5 + 0.5 * sin(tt * 4.0 - d * 0.03);
      let ring = 1.0 - smoothstep(px * 1.5, px * 3.5, abs(d - m.z));
      let fillA = (1.0 - smoothstep(m.z * 0.9, m.z, d)) * 0.10;
      outc = mix(outc, toolColor(m.w), clamp(ring * (0.45 + 0.4 * pulse) + fillA, 0.0, 1.0) * a);
    }
  }
  if (R_.cursor.w > 0.5) {
    let c = R_.cursor;
    let d = length(wp.xz - c.xy);
    let ang = atan2(wp.z - c.y, wp.x - c.x);
    let dash = step(0.0, sin(ang * 24.0 + tt * 2.5));
    let ring = 1.0 - smoothstep(px * 1.2, px * 3.0, abs(d - c.z));
    let halo = (1.0 - smoothstep(px * 3.0, px * 12.0, abs(d - c.z))) * 0.25;
    let inner = (1.0 - smoothstep(c.z * 0.8, c.z, d)) * 0.12;
    let cdot = 1.0 - smoothstep(px * 1.5, px * 3.0, d);
    let tc = toolColor(c.w);
    outc = mix(outc, tc * 0.35, halo);
    outc = mix(outc, tc, clamp(inner + cdot, 0.0, 1.0));
    outc = mix(outc, mix(vec3f(1.0), tc, 0.5 + 0.5 * dash), ring);
  }
  if (R_.ripple.w < 1.0) {
    let r = R_.ripple;
    let d = length(wp.xz - r.xy);
    let rr = r.z * (0.2 + 1.6 * r.w);
    let ring = (1.0 - smoothstep(px * 2.0, px * 2.0 + r.z * 0.12, abs(d - rr))) * (1.0 - r.w);
    outc = mix(outc, R_.ripCol.rgb, ring * 0.9);
  }
  // Optional faint contour lines every 100 m for reading heights.
  let fw = fwidth(ground);
  if (R_.misc.w > 0.5) {
    let cl = 1.0 - smoothstep(0.0, fw * 1.2, abs(fract(ground / 100.0 + 0.5) - 0.5) * 100.0);
    outc = mix(outc, outc * 0.5, cl * 0.6);
  }
  return vec4f(outc, 1.0);
}`;

// Sides of the terrain block, showing sediment beds over soil over bedrock in cross-section.
export const SKIRT = UNIFORMS + COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
@group(0) @binding(3) var<storage, read> deposit: array<vec4f>;
struct VO {
  @builtin(position) pos: vec4f, @location(0) wpos: vec3f, @location(1) info: vec3f, @location(2) nrm: vec3f, @location(3) gxy: vec2f,
  @location(4) ek: f32,                              // position along the edge, in cells
  @location(5) @interpolate(flat) edge: u32,
};
// grid cell at position kk along edge 0..3 (same walk as the vertex shader)
fn edgeCell(edge: u32, kk: u32) -> u32 {
  let n = u32(R_.grid.x);
  if (edge == 0u) { return kk; }
  if (edge == 1u) { return kk * n + n - 1u; }
  if (edge == 2u) { return (n - 1u) * n + n - 1u - kk; }
  return (n - 1u - kk) * n;
}
// Sediment bed at depth below the ground in cell i: rgb, a = 1 inside a bed (0 below the stack).
// Depth and the soil depth it is cut off at come from the interpolated side so the beds follow the
// face smoothly. Each bed has a darker seam at its base.
fn bedAt(i: u32, depth: f32, soilD: f32, y: f32, along: f32) -> vec4f {
  if (depth < 0.0 || depth > soilD) { return vec4f(0.0); }
  let ta = deposit[4u * i]; let tb = deposit[4u * i + 1u];
  let th = array<f32, 8>(ta.x, ta.y, ta.z, ta.w, tb.x, tb.y, tb.z, tb.w);
  let ga = deposit[4u * i + 2u]; let gb = deposit[4u * i + 3u];
  let tg = array<f32, 8>(ga.x, ga.y, ga.z, ga.w, gb.x, gb.y, gb.z, gb.w);
  var top = 0.0;
  for (var k = 0; k < 8; k++) {
    let base = top + th[k];
    if (th[k] > 1e-4 && depth < base) {
      let gr = fract(tg[k]) / 0.99;
      let speck = 1.0 + smoothstep(0.7, 1.0, gr) * (vnoise(vec2f(along * 1.7, y * 6.0)) - 0.5) * 0.5;
      let seam = 1.0 - 0.3 * (1.0 - smoothstep(0.0, max(0.06 * th[k], 0.03), base - depth));
      return vec4f(bedColor(gr, bedHash(floor(tg[k]))) * 0.9 * speck * seam, 1.0);
    }
    top = base;
  }
  return vec4f(0.0);
}
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let n = u32(R_.grid.x);
  let dx = R_.grid.y;
  let vex = R_.sunColor.w;
  let c = (f32(n) - 1.0) * 0.5;
  let seg = vi / 6u;
  let corner = vi % 6u;
  let edge = seg / (n - 1u);
  let k = seg % (n - 1u);
  let tri = array<vec2u, 6>(vec2u(0u, 0u), vec2u(1u, 0u), vec2u(0u, 1u), vec2u(1u, 0u), vec2u(1u, 1u), vec2u(0u, 1u));
  let t = tri[corner];
  let kk = k + t.x;
  var gx = 0u; var gy = 0u; var nrm = vec3f(0.0);
  if (edge == 0u) { gx = kk; gy = 0u; nrm = vec3f(0.0, 0.0, -1.0); }
  else if (edge == 1u) { gx = n - 1u; gy = kk; nrm = vec3f(1.0, 0.0, 0.0); }
  else if (edge == 2u) { gx = n - 1u - kk; gy = n - 1u; nrm = vec3f(0.0, 0.0, 1.0); }
  else { gx = 0u; gy = n - 1u - kk; nrm = vec3f(-1.0, 0.0, 0.0); }
  let i = gy * n + gx;
  let b = bedrock[i];
  let g = b + soil[i];
  let bottom = R_.misc.z - 120.0;
  var y = g;
  if (t.y == 1u) { y = bottom; }
  var o: VO;
  let wp = vec3f((f32(gx) - c) * dx, y * vex, (f32(gy) - c) * dx);
  o.pos = R_.viewProj * vec4f(wp, 1.0);
  o.wpos = wp;
  o.info = vec3f(y, b, g);
  o.gxy = vec2f(f32(gx), f32(gy));
  o.nrm = nrm;
  o.ek = f32(kk);
  o.edge = edge;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let y = i.info.x;
  let b = i.info.y;
  let p = i.wpos.xz;
  let along = p.x + p.y;
  let lay = y + vnoise(vec2f(along * 0.0025, 0.0)) * 40.0 + fbm(vec2f(along * 0.02, y * 0.02)) * 12.0;
  let band = smoothstep(0.25, 0.75, sin(lay * 0.045 + 1.7 * sin(lay * 0.013)) * 0.5 + 0.5);
  var c = mix(R_.rock.rgb, R_.rock2.rgb, band * max(R_.rock.w, 0.35)) * 0.8;
  let stc = strataRock(y, i.gxy);
  c = mix(c, stc.rgb * 0.8, stc.a * 0.9);
  // Soil layer sits on top of bedrock (exaggerated a little so thin soils stay visible).
  if (y > b - 0.3) { c = R_.soilC.rgb * 0.9; }
  // Sediment beds on top of the soil, youngest at the top: the stacks of the two nearest columns,
  // blended along the edge so beds run on as sheets and pinch out smoothly instead of in 10 m blocks.
  let n = u32(R_.grid.x);
  let k0 = min(u32(max(floor(i.ek), 0.0)), n - 1u);
  let f = clamp(i.ek - f32(k0), 0.0, 1.0);
  let dep = i.info.z - y;
  let sd = i.info.z - i.info.y;
  let cL = bedAt(edgeCell(i.edge, k0), dep, sd, y, along);
  let cR = bedAt(edgeCell(i.edge, min(k0 + 1u, n - 1u)), dep, sd, y, along);
  let wL = cL.a * (1.0 - f); let wR = cR.a * f;
  if (wL + wR > 0.0) { c = mix(c, (cL.rgb * wL + cR.rgb * wR) / (wL + wR), smoothstep(0.0, 0.6, wL + wR)); }
  let L = normalize(R_.sunDir.xyz);
  let ndl = max(dot(i.nrm, L), 0.0);
  let shade = 0.45 + 0.55 * ndl * R_.sunDir.w;
  let fade = smoothstep(R_.misc.z - 120.0, R_.misc.z + 60.0, y);
  var col = c * shade * (0.55 + 0.45 * fade);
  col = applyHaze(col, i.wpos);
  return vec4f(tonemap(col), 1.0);
}`;

export const WATER = UNIFORMS + COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
@group(0) @binding(3) var<storage, read> water: array<f32>;
@group(0) @binding(4) var<storage, read> velX: array<f32>;
@group(0) @binding(5) var<storage, read> velY: array<f32>;
@group(0) @binding(6) var<storage, read> sediment: array<f32>;
@group(0) @binding(7) var<storage, read> light: array<vec4u>;
@group(0) @binding(8) var<storage, read> snowSWE: array<f32>;
@group(0) @binding(9) var<storage, read> glacier: array<vec4f>;
fn gi(x: i32, y: i32) -> u32 {
  let n = i32(R_.grid.x);
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn surf(i: u32) -> f32 {
  let w = water[i];
  let g = bedrock[i] + soil[i];
  if (w < 0.0005) { return g - 0.15; }   // dry: tuck the surface under the ground for clean shorelines
  return g + w;
}
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) d: vec4f,      // depth, velX, velY, sediment
  @location(3) e: vec4f,      // sun visibility, ao, snow, grid slope
};
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let n = u32(R_.grid.x);
  let x = i32(vi % n); let y = i32(vi / n);
  let i = vi;
  let dx = R_.grid.y;
  let vex = R_.sunColor.w;
  let c = (f32(n) - 1.0) * 0.5;
  let s = surf(i);
  let sl = surf(gi(x - 1, y)); let sr = surf(gi(x + 1, y));
  let st = surf(gi(x, y - 1)); let sb = surf(gi(x, y + 1));
  var o: VO;
  let wp = vec3f((f32(x) - c) * dx, s * vex, (f32(y) - c) * dx);
  o.pos = R_.viewProj * vec4f(wp, 1.0);
  o.wpos = wp;
  o.nrm = normalize(vec3f((sl - sr) * vex, 2.0 * dx, (st - sb) * vex));
  o.d = vec4f(water[i], velX[i], velY[i], sediment[i]);
  let L = light[i];
  let g = bedrock[i] + soil[i];
  let gs = length(vec2f(bedrock[gi(x + 1, y)] + soil[gi(x + 1, y)] - bedrock[gi(x - 1, y)] - soil[gi(x - 1, y)],
                        bedrock[gi(x, y + 1)] + soil[gi(x, y + 1)] - bedrock[gi(x, y - 1)] - soil[gi(x, y - 1)])) / (2.0 * dx);
  let la = unpack2x16unorm(L.x);
  o.e = vec4f(la.x, la.y, snowSWE[i] + glacier[i].x, gs);   // meltwater under a glacier is hidden like water under snow
  return o;
}
// Ripple height field, advected along the flow (two-phase flow map to avoid stretching).
fn ripple(p: vec2f, t: f32) -> f32 {
  return vnoise(p * 0.35 + vec2f(t * 0.3, t * 0.21)) * 0.6 + vnoise(p * 0.9 - vec2f(t * 0.5, -t * 0.4)) * 0.4;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let depth = i.d.x;
  if (depth < 0.0005) { discard; }
  let time = R_.camPos.w;
  let vel = vec2f(i.d.y, i.d.z);
  let speed = length(vel);
  let p = i.wpos.xz;
  // Flow map: two phases offset by half a cycle.
  let ph0 = fract(time * 0.35);
  let ph1 = fract(time * 0.35 + 0.5);
  let wgt = abs(ph0 - 0.5) * 2.0;
  let adv = vel * 6.0;
  let q0 = p - adv * ph0;
  let q1 = p - adv * ph1;
  let e = 0.6;
  let r0 = ripple(q0, time); let r1 = ripple(q1, time);
  let gx = mix(ripple(q0 + vec2f(e, 0.0), time) - r0, ripple(q1 + vec2f(e, 0.0), time) - r1, wgt) / e;
  let gz = mix(ripple(q0 + vec2f(0.0, e), time) - r0, ripple(q1 + vec2f(0.0, e), time) - r1, wgt) / e;
  let rough = 0.08 + min(speed, 4.0) * 0.12;
  let n = normalize(normalize(i.nrm) + vec3f(-gx, 0.0, -gz) * rough);

  let V = normalize(R_.camPos.xyz - i.wpos);
  let L = normalize(R_.sunDir.xyz);
  let sunVis = i.e.x;
  let cloud = R_.veg.w;
  let sunI = R_.sunDir.w * (1.0 - 0.75 * cloud);
  // Depth-tinted body colour; sediment turns it milky brown.
  let turb = clamp(i.d.w / (depth * 0.02 + 1e-4), 0.0, 1.0) * smoothstep(0.2, 1.5, speed + 0.5);
  let shallow = srgb(mix(vec3f(0.16, 0.42, 0.42), vec3f(0.42, 0.34, 0.22), turb));
  let deep = srgb(mix(vec3f(0.04, 0.13, 0.22), vec3f(0.20, 0.15, 0.09), turb));
  let k = 1.0 - exp(-depth / 2.5);
  var body = mix(shallow, deep, k);
  let amb = mix(R_.skyHorizon.rgb, R_.skyZenith.rgb, 0.6) * (0.6 + 0.3 * cloud);
  body = body * (amb * 0.9 + R_.sunColor.rgb * max(dot(n, L), 0.0) * sunVis * sunI * 1.2) * mix(0.5, 1.0, i.e.y);
  // Fresnel sky reflection and sun glint.
  let cosT = max(dot(n, V), 0.0);
  let F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  let refl = skyColor(reflect(-V, n));
  var col = mix(body, refl, F * 0.9);
  let Hh = normalize(L + V);
  col += R_.sunColor.rgb * pow(max(dot(n, Hh), 0.0), 220.0) * 3.0 * sunVis * sunI;
  // Whitewater on fast, steep flow.
  let foamN = vnoise(p * 0.6 - vel * time * 1.5);
  let foam = smoothstep(2.0, 5.0, speed * (0.6 + i.e.w)) * smoothstep(0.35, 0.75, foamN);
  col = mix(col, srgb(vec3f(0.92, 0.95, 0.97)) * (0.6 + 0.4 * sunVis), foam * 0.7);
  // Opacity grows with depth; thin sheets are a faint wet glaze.
  var alpha = clamp(0.25 + 0.75 * (1.0 - exp(-depth / 0.35)), 0.0, 0.96);
  // Streams: even shallow water reads clearly where it is actually flowing (unit discharge h*v).
  let q = depth * speed;
  alpha = alpha * max(smoothstep(0.003, 0.03, depth), smoothstep(0.002, 0.02, q) * 0.85);
  alpha = max(alpha, F * smoothstep(0.001, 0.01, depth));
  // Water hidden under deep snow (frozen over).
  alpha = alpha * (1.0 - smoothstep(0.05, 0.3, i.e.z));
  col = applyHaze(col, i.wpos);
  return vec4f(tonemap(col), alpha);
}`;

// Falling rain or snow drawn as a screen-space layer.
export const PRECIP = UNIFORMS + COMMON + /* wgsl */ `
struct VO { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VO {
  let p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o: VO;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = p[vi] * 0.5 + 0.5;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let amt = R_.sand.w;
  if (amt < 0.01) { discard; }
  let isSnow = R_.misc.x;
  let t = R_.camPos.w;
  // Square cells in pixel space so flakes stay round at any window shape.
  let px = i.pos.xy;
  var a = 0.0;
  for (var layer = 0; layer < 3; layer++) {
    let fl = f32(layer);
    let cellPx = mix(46.0, 34.0, isSnow) / (1.0 + fl * 0.6);
    let fall = mix(1400.0, 90.0, isSnow) / (1.0 + fl * 0.5);
    let drift = mix(120.0, 30.0, isSnow) + sin(t * 0.6 + fl) * 25.0 * isSnow;
    let p = (px + vec2f(-t * drift, -t * fall)) / cellPx;
    let cell = floor(p);
    let f = fract(p);
    let h = hash2(cell + fl * 31.7);
    if (h > amt * 0.75 + 0.08) { continue; }
    let c = vec2f(hash2(cell * 1.31 + 5.7), hash2(cell * 2.17 + 1.3)) * 0.7 + 0.15;
    let d = f - c;
    // Rain: thin slanted streaks. Snow: soft round flakes.
    let streak = (1.0 - smoothstep(0.0, 0.035, abs(d.x + d.y * 0.08))) * (1.0 - smoothstep(0.0, 0.35, abs(d.y)));
    let flake = 1.0 - smoothstep(0.025, 0.075 * (1.0 - fl * 0.2), length(d));
    a += mix(streak * 0.30, flake * 0.85, isSnow) / (1.0 + fl * 0.5);
  }
  let col = mix(vec3f(0.80, 0.85, 0.90), vec3f(1.0, 1.0, 1.0), isSnow);
  return vec4f(col, clamp(a, 0.0, 0.7) * min(amt * 1.5, 1.0));
}`;

// ---------------------------------------------------------------------------------------------
// Round 2: trees, smoke and storm clouds.
//
// COMPACT (compute) walks the grid every lighting update and appends visible tree and fire cells
// to two instance lists with atomic counters that double as drawIndirect arguments, so only real
// trees are drawn: a cell gets a tree with probability cover x woody share, a dead snag where a
// recent burn killed the stand. Off-screen and sub-pixel trees are skipped.
export const COMPACT = /* wgsl */ `
struct C { viewProj: mat4x4f, N: u32, cap: u32, fcap: u32, pad: u32, dx: f32, vex: f32, pxScale: f32, dens: f32 };
@group(0) @binding(0) var<uniform> U: C;
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
@group(0) @binding(3) var<storage, read> light: array<vec4u>;
@group(0) @binding(4) var<storage, read_write> trees: array<u32>;
@group(0) @binding(5) var<storage, read_write> fires: array<u32>;
@group(0) @binding(6) var<storage, read_write> args: array<atomic<u32>>;
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= U.N || g.y >= U.N) { return; }
  let i = g.y * U.N + g.x;
  let c = unpack4x8unorm(light[i].z);
  let h = f32(pcg(i) & 0xffffu) / 65536.0;
  let dens = c.x * c.y * U.dens;
  var kind = 0u;
  if (h < dens) { kind = 1u; } else if (c.z > 0.04 && h < dens + c.z * 0.35) { kind = 2u; }
  let onFire = c.w > 0.06 && (pcg(i * 7u + 3u) & 255u) < 110u;
  if (kind == 0u && !onFire) { return; }
  let ctr = (f32(U.N) - 1.0) * 0.5;
  let wp = vec4f((f32(g.x) - ctr) * U.dx, (bedrock[i] + soil[i]) * U.vex + 8.0, (f32(g.y) - ctr) * U.dx, 1.0);
  let cp = U.viewProj * wp;
  if (cp.w <= 1.0) { return; }
  let m = cp.w * 1.08 + 40.0;
  if (abs(cp.x) > m || abs(cp.y) > m) { return; }
  if (kind > 0u && 22.0 * U.pxScale / cp.w > 0.6) {
    let k = atomicAdd(&args[1], 1u);
    if (k < U.cap) { trees[k] = i | (kind << 28u); }
  }
  if (onFire) {
    let k = atomicAdd(&args[5], 1u);
    if (k < U.fcap) { fires[k] = i; }
  }
}
@compute @workgroup_size(1)
fn clampArgs() {
  atomicMin(&args[1], U.cap);
  atomicMin(&args[5], U.fcap);
}`;

const TREE_DATA = /* wgsl */ `
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
@group(0) @binding(3) var<storage, read> light: array<vec4u>;
@group(0) @binding(4) var<storage, read> list: array<u32>;
@group(0) @binding(5) var<storage, read> snowSWE: array<f32>;
fn gi(x: i32, y: i32) -> u32 {
  let n = i32(R_.grid.x);
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn gh(x: i32, y: i32) -> f32 { let j = gi(x, y); return bedrock[j] + soil[j]; }
fn hu(v: u32) -> f32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return f32(((w >> 22u) ^ w) & 0xffffu) / 65536.0;
}
fn stormShadeAt(p: vec2f) -> f32 {
  var s = 1.0;
  for (var k = 0; k < 4; k++) {
    let sv = R_.st[k];
    if (sv.w > 0.0) { s = s * (1.0 - 0.75 * sv.w * (1.0 - smoothstep(0.7, 1.6, length(p - sv.xy) / max(sv.z, 1.0)))); }
  }
  return s;
}
`;

// Low-poly trees: a 6-sided double cone per tree, shaped per species. Conifers (spruce, fir,
// Douglas fir), broadleaf (aspen, maple: green, then gold or red in autumn, bare in winter),
// pinyon-juniper (round, low, dark) and burnt snags. Colours follow drought and fire.
export const TREES = UNIFORMS + COMMON + TREE_DATA + /* wgsl */ `
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) col: vec3f,
  @location(3) lit: vec3f,    // sun visibility, ao, fire glow
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let e = list[ii];
  let i = e & 0x0fffffffu;
  let kind = e >> 28u;
  let n = u32(R_.grid.x);
  let x = i32(i % n); let y = i32(i / n);
  let dx = R_.grid.y; let vex = R_.sunColor.w;
  let L = light[i];
  let la = unpack2x16unorm(L.x);
  let c = unpack4x8unorm(L.z);
  let moist = unpack4x8unorm(L.w).x;
  let h1 = hu(i * 3u + 1u); let h2 = hu(i * 5u + 2u); let h3 = hu(i * 11u + 7u); let h4 = hu(i * 13u + 5u);
  // jittered position, ground height bilinear
  let jx = (h1 - 0.5) * 0.7; let jy = (h2 - 0.5) * 0.7;
  let fx = f32(x) + jx; let fy = f32(y) + jy;
  let x0 = i32(floor(fx)); let y0 = i32(floor(fy));
  let tx = fx - f32(x0); let ty = fy - f32(y0);
  let ground = mix(mix(gh(x0, y0), gh(x0 + 1, y0), tx), mix(gh(x0, y0 + 1), gh(x0 + 1, y0 + 1), tx), ty);
  let ctr = (f32(n) - 1.0) * 0.5;
  let base = vec3f((fx - ctr) * dx, ground * vex, (fy - ctr) * dx);
  let elevAbs = ground + R_.grid.z;
  let dry = clamp(1.0 - moist * 1.25 + R_.misc2.x * 0.15, 0.0, 1.0);
  // species (same noise as the terrain canopy colour, so patches agree)
  let coldBoost = clamp((-1.0 - tMeanAt(elevAbs)) * 0.15, -0.4, 0.5);
  let conN = clamp(R_.forest.x + coldBoost, 0.0, 1.0) + (vnoise(base.xz * 0.04) - 0.5) * 0.6;
  let pjShare = R_.forest.z * (1.0 - smoothstep(0.3, 0.7, moist));
  var sp = 1u;                                       // 0 conifer, 1 broadleaf, 2 pinyon-juniper, 3 snag
  if (kind == 2u) { sp = 3u; }
  else if (h3 < pjShare) { sp = 2u; }
  else if (smoothstep(0.35, 0.65, conN) > h4) { sp = 0u; }
  let m = clamp(c.y * 1.2, 0.25, 1.0);
  let s = (0.75 + 0.5 * h3) * R_.misc2.w;
  let leaf = leafColor(elevAbs, h4, dry);
  var H = 0.0; var hb = 0.0; var hm = 0.0; var Rr = 0.0; var col = vec3f(0.0);
  if (sp == 0u) {
    H = (7.0 + 19.0 * m) * s; hb = 0.06 * H; hm = 0.26 * H; Rr = 0.23 * H;
    col = mix(srgb(vec3f(0.10, 0.20, 0.12)), srgb(vec3f(0.45, 0.33, 0.16)), smoothstep(0.6, 0.95, dry));
  } else if (sp == 1u) {
    H = (6.0 + 12.0 * m) * s; hb = 0.30 * H; hm = 0.60 * H; Rr = 0.36 * H * mix(0.7, 1.0, leaf.a);
    col = mix(srgb(vec3f(0.36, 0.33, 0.31)), leaf.rgb, leaf.a);
  } else if (sp == 2u) {
    H = (2.5 + 4.5 * m) * s; hb = 0.03 * H; hm = 0.45 * H; Rr = 0.48 * H;
    col = srgb(mix(vec3f(0.20, 0.27, 0.17), vec3f(0.36, 0.38, 0.26), h1));
  } else {
    H = (7.0 + 10.0 * h4) * R_.misc2.w; hb = 0.0; hm = 0.12 * H; Rr = 0.035 * H;
    col = srgb(vec3f(0.05, 0.045, 0.04));
  }
  col = col * (0.85 + 0.3 * h2);
  if (sp != 3u) { col = mix(col, srgb(vec3f(0.08, 0.07, 0.06)), smoothstep(0.2, 0.6, c.z) * 0.8); }   // scorched
  // the triangle this vertex belongs to
  let t = vi / 3u; let cr = vi % 3u;
  let k = t % 6u; let upper = t < 6u;
  let a0 = (f32(k) + h1) * 1.0471976; let a1 = (f32(k + 1u) + h1) * 1.0471976;
  let r0 = vec3f(Rr * cos(a0), hm, Rr * sin(a0));
  let r1 = vec3f(Rr * cos(a1), hm, Rr * sin(a1));
  let sway = vec3f(sin(R_.camPos.w * 1.3 + h2 * 20.0), 0.0, cos(R_.camPos.w * 1.1 + h1 * 20.0)) * 0.025 * H;
  let apex = select(vec3f(0.0, hb, 0.0), vec3f(0.0, H, 0.0) + sway, upper);
  var P0 = r0; var P1 = r1; let P2 = apex;
  if (!upper) { P0 = r1; P1 = r0; }
  var nn = normalize(cross(P1 - P0, P2 - P0));
  let cen = (P0 + P1 + P2) / 3.0;
  if (dot(nn, vec3f(cen.x, 0.0, cen.z)) < 0.0) { nn = -nn; }
  nn = normalize(nn + 0.5 * normalize(vec3f(cen.x, 0.001, cen.z)));
  var lp = P0;
  if (cr == 1u) { lp = P1; } else if (cr == 2u) { lp = P2; }
  // snow on conifer boughs in winter
  let snowy = smoothstep(0.005, 0.05, snowSWE[i]) * (1.0 - smoothstep(-1.0, 1.5, tNowAt(elevAbs)));
  if (sp == 0u) { col = mix(col, srgb(vec3f(0.90, 0.93, 0.97)), snowy * smoothstep(0.1, 0.7, nn.y) * 0.8); }
  let wp = base + lp;
  var o: VO;
  o.pos = R_.viewProj * vec4f(wp, 1.0);
  o.wpos = wp;
  o.nrm = nn;
  o.col = col;
  o.lit = vec3f(la.x, la.y, c.w);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let n = normalize(i.nrm);
  let L = normalize(R_.sunDir.xyz);
  let cloud = R_.veg.w;
  let sunI = R_.sunDir.w * (1.0 - 0.75 * cloud);
  let sh = stormShadeAt(i.wpos.xz);
  let ndl = max(dot(n, L), 0.0) * 0.8 + 0.2 * max(n.y, 0.0);
  let ao = mix(0.45, 1.0, i.lit.y);
  let direct = R_.sunColor.rgb * ndl * i.lit.x * sunI * 2.8 * sh;
  let amb = mix(R_.skyHorizon.rgb, R_.skyZenith.rgb, 0.5 + 0.5 * n.y) * (0.5 + 0.4 * cloud) * ao;
  var col = i.col * (direct + amb * 0.85);
  col = col * (1.0 + R_.stX.z * 0.9 * (1.0 - sh));
  col = applyHaze(col, i.wpos);
  var outc = tonemap(col);
  if (i.lit.z > 0.03) {
    let fl = vnoise(i.wpos.xz * 0.2 + vec2f(0.0, R_.camPos.w * 3.0));
    outc = mix(outc, vec3f(1.0, 0.5, 0.1) * (0.8 + 0.6 * fl), clamp(i.lit.z * 1.2, 0.0, 0.95));
  }
  return vec4f(outc, 1.0);
}`;

// Smoke from burning cells: three camera-facing puffs per fire cell, rising and drifting downwind.
export const SMOKE = UNIFORMS + COMMON + TREE_DATA + /* wgsl */ `
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) a: vec3f,      // alpha, phase, seed
  @location(2) wpos: vec3f,
};
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let i = list[ii];
  let n = u32(R_.grid.x);
  let x = f32(i % n); let y = f32(i / n);
  let dx = R_.grid.y; let vex = R_.sunColor.w;
  let fire = unpack4x8unorm(light[i].z).w;
  let ctr = (f32(n) - 1.0) * 0.5;
  let base = vec3f((x - ctr) * dx, (bedrock[i] + soil[i]) * vex, (y - ctr) * dx);
  let k = vi / 6u; let cr = vi % 6u;
  let qs = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let q = qs[cr];
  let h = hu(i * 17u + k * 3u);
  let ph = fract(R_.camPos.w * 0.16 + h + f32(k) / 3.0);
  let wind = vec2f(R_.camRight.w, R_.camUp.w);
  let size = (18.0 + 95.0 * ph) * (0.7 + 0.6 * h);
  let c = base + vec3f(wind.x * ph * 160.0, 10.0 + ph * 300.0, wind.y * ph * 160.0);
  let wp = c + R_.camRight.xyz * q.x * size + R_.camUp.xyz * q.y * size;
  var o: VO;
  o.pos = R_.viewProj * vec4f(wp, 1.0);
  o.q = q;
  o.a = vec3f(min(fire * 1.5, 1.0) * (1.0 - ph) * smoothstep(0.0, 0.1, ph) * 0.8, ph, h);
  o.wpos = wp;
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let d = length(i.q);
  let nz = vnoise(i.q * 2.2 + vec2f(i.a.z * 40.0, R_.camPos.w * 0.3));
  let a = i.a.x * (1.0 - smoothstep(0.35, 1.0, d + (nz - 0.5) * 0.5));
  if (a < 0.003) { discard; }
  let sunI = R_.sunDir.w;
  var c = srgb(vec3f(0.42, 0.40, 0.39)) * (R_.sunColor.rgb * 1.6 * sunI + mix(R_.skyHorizon.rgb, R_.skyZenith.rgb, 0.5) * 0.6);
  c = mix(c, srgb(vec3f(1.0, 0.45, 0.12)) * 2.0, (1.0 - smoothstep(0.0, 0.18, i.a.y)) * 0.7);
  c = applyHaze(c, i.wpos);
  return vec4f(tonemap(c), a);
}`;

// Storm clouds for painted cloudbursts: a dark cloud deck with a puffy top and a rain (or snow)
// curtain down to the ground. One instance per active storm; 480 vertices each.
export const STORMFX = UNIFORMS + COMMON + /* wgsl */ `
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) wpos: vec3f,
  @location(1) uv: vec3f,     // curtain: (along, y, part) cloud: (local x, local z, part)
  @location(2) s: vec2f,      // strength, radius
};
const SEG: u32 = 40u;
@vertex fn vs(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VO {
  let sv = R_.st[ii];
  let ctr = vec3f(sv.x, 0.0, sv.y);
  let base = R_.stX.x; let top = R_.stX.w;
  let ground = R_.misc.z * R_.sunColor.w - 60.0;
  var p = vec3f(0.0); var uv = vec3f(0.0);
  if (vi < SEG * 6u) {
    // rain curtain
    let s = vi / 6u; let cr = vi % 6u;
    let qs = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(1.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 0.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
    let q = qs[cr];
    let a = (f32(s) + q.x) * 6.2831853 / f32(SEG);
    let rc = sv.z * 0.72;
    p = ctr + vec3f(rc * cos(a), mix(ground, base + 20.0, q.y), rc * sin(a));
    uv = vec3f(a * rc, p.y, 0.0);
  } else {
    let j = vi - SEG * 6u;
    let isTop = j >= SEG * 3u;
    let jj = j % (SEG * 3u);
    let s = jj / 3u; let cr = jj % 3u;
    let rc = sv.z * 1.3;
    var a = f32(s) * 6.2831853 / f32(SEG);
    if (cr == 1u) { a = f32(s + 1u) * 6.2831853 / f32(SEG); }
    let wob = 1.0 + 0.12 * sin(a * 5.0 + f32(ii) * 2.0) + 0.06 * sin(a * 11.0);
    if (cr == 2u) {
      p = ctr + vec3f(0.0, select(base - 10.0, top, isTop), 0.0);
    } else {
      p = ctr + vec3f(rc * wob * cos(a), base + select(0.0, (top - base) * 0.25, isTop), rc * wob * sin(a));
    }
    uv = vec3f(p.x - ctr.x, p.z - ctr.z, select(1.0, 2.0, isTop));
  }
  var o: VO;
  o.pos = R_.viewProj * vec4f(p, 1.0);
  o.wpos = p;
  o.uv = uv;
  o.s = vec2f(sv.w, sv.z);
  return o;
}
@fragment fn fs(i: VO) -> @location(0) vec4f {
  let t = R_.camPos.w;
  let str = i.s.x;
  let snow = R_.stX.y;
  let flash = R_.stX.z;
  var c = vec3f(0.0); var a = 0.0;
  if (i.uv.z < 0.5) {
    let rainN = vnoise(vec2f(i.uv.x * 0.30, i.uv.y * 0.010 + t * 7.0)) * 0.6 + vnoise(vec2f(i.uv.x * 0.9, i.uv.y * 0.03 + t * 11.0)) * 0.4;
    let snowN = vnoise(vec2f(i.uv.x * 0.15 + sin(t + i.uv.y * 0.01) * 2.0, i.uv.y * 0.02 + t * 0.9));
    let n = mix(rainN, snowN, snow);
    let fadeTop = 1.0 - smoothstep(R_.stX.x - 120.0, R_.stX.x + 20.0, i.uv.y);
    let sheet = 0.5 + 0.5 * vnoise(vec2f(i.uv.x * 0.004 + t * 0.15, t * 0.1));
    a = (0.10 + 0.35 * smoothstep(0.5, 0.85, n)) * str * (0.35 + 0.65 * fadeTop) * (0.55 + 0.45 * sheet);
    c = mix(srgb(vec3f(0.55, 0.60, 0.68)), srgb(vec3f(0.95, 0.96, 0.98)), snow);
    c = c * (0.6 + 0.6 * R_.sunDir.w) + vec3f(flash * 1.5);
  } else {
    let r = length(i.uv.xy) / (i.s.y * 1.3);
    let n = fbm(i.uv.xy * 0.004 + vec2f(t * 0.03, t * 0.017));
    let isTop = i.uv.z > 1.5;
    a = str * (1.0 - smoothstep(0.55, 1.05, r + (n - 0.5) * 0.5)) * select(0.92, 0.85, isTop);
    let dark = mix(srgb(vec3f(0.16, 0.17, 0.20)), srgb(vec3f(0.30, 0.31, 0.34)), n);
    let lit = mix(srgb(vec3f(0.55, 0.56, 0.60)), srgb(vec3f(0.85, 0.86, 0.88)), n) * (0.6 + 0.6 * R_.sunDir.w);
    c = select(dark, lit, isTop);
    c = c + vec3f(0.9, 0.92, 1.0) * flash * max(1.2 - r, 0.0) * 2.0;
  }
  if (a < 0.004) { discard; }
  c = applyHaze(c, i.wpos);
  return vec4f(tonemap(c), clamp(a, 0.0, 0.95));
}`;
