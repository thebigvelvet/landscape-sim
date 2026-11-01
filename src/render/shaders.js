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
};
@group(0) @binding(0) var<uniform> R_: R;
`;

export const COMMON = /* wgsl */ `
fn srgb(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }
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
@group(0) @binding(7) var<storage, read> light: array<vec2f>;
@group(0) @binding(8) var<storage, read> height0: array<f32>;
fn gi(x: i32, y: i32) -> u32 {
  let n = i32(R_.grid.x);
  return u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
}
fn dispH(i: u32) -> f32 { return bedrock[i] + soil[i] + snowSWE[i] / 0.33; }
`;

export const TERRAIN = UNIFORMS + COMMON + TERRAIN_DATA + /* wgsl */ `
struct VO {
  @builtin(position) pos: vec4f,
  @location(0) wpos: vec3f,
  @location(1) nrm: vec3f,
  @location(2) m0: vec4f,   // soil, snowSWE, water, sediment
  @location(3) m1: vec4f,   // frost, sun visibility, ao, height change since start
  @location(4) m2: vec4f,   // ground height (m), grid x, grid y, ground slope (tan)
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
  o.m1 = vec4f(frostDepth[i], L.x, L.y, ground - height0[i]);
  o.m2 = vec4f(ground, f32(x), f32(y), gslope);
  return o;
}

fn ramp3(t: f32, a: vec3f, b: vec3f, c: vec3f) -> vec3f {
  let s = clamp(t, 0.0, 1.0);
  if (s < 0.5) { return mix(a, b, s * 2.0); }
  return mix(b, c, s * 2.0 - 2.0 * 0.5);
}

// Overlay colour maps. Must match the legends drawn in src/ui/legend.js.
fn overlay(mode: i32, m0: vec4f, m1: vec4f) -> vec4f {
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
  rockC = rockC * (0.8 + 0.3 * band2 * bandStr + 0.25 * (nzf - 0.5));
  // --- Loose material: talus on steep slopes, soil on gentle ground.
  let steep = smoothstep(0.35, 0.75, slopeTan);
  var looseC = mix(R_.soilC.rgb, R_.talus.rgb, steep);
  looseC = looseC * (0.9 + 0.2 * nzf);
  // Fresh deposits (alluvium) since the start show as sand/gravel.
  let fresh = smoothstep(0.15, 2.0, i.m1.w);
  looseC = mix(looseC, R_.sand.rgb * (0.85 + 0.3 * nzf), fresh * 0.6);
  // Gravelly speckle so broad soil and talus areas are not flat colour.
  let grit = vnoise(p2 * 1.3) * 0.6 + vnoise(p2 * 3.7) * 0.4;
  looseC = looseC * (0.82 + 0.3 * grit);
  // Vegetation: needs soil, moderate slope and a mild enough climate (below treeline).
  let tMean = R_.grid.w - R_.soilC.w * elevAbs / 1000.0;
  let season = R_.talus.w;
  let summer = 0.5 + 0.5 * cos(6.2831853 * (season - 0.55));
  let vegOk = smoothstep(-1.5, 3.0, tMean) * smoothstep(0.15, 0.6, soilD) * (1.0 - smoothstep(0.45, 0.9, slopeTan));
  let vegAmt = clamp(vegOk * R_.rock2.w * (0.75 + 0.5 * nz), 0.0, 1.0);
  let vegC = mix(R_.veg.rgb * vec3f(1.25, 1.05, 0.7), R_.veg.rgb, summer) * (0.8 + 0.4 * nzf);
  let looseWithVeg = mix(looseC, vegC, vegAmt);

  let rockExpo = 1.0 - smoothstep(0.03, 0.35, soilD + (nzf - 0.5) * 0.1);
  var albedo = mix(looseWithVeg, rockC, rockExpo);

  // Wet ground darkens.
  let wet = smoothstep(0.0005, 0.02, wdep);
  albedo = albedo * (1.0 - 0.35 * wet);
  // Hoar frost on frozen bare ground.
  albedo = mix(albedo, srgb(vec3f(0.80, 0.84, 0.88)), smoothstep(0.05, 0.5, i.m1.x) * 0.18 * (1.0 - wet));

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
  let direct = R_.sunColor.rgb * ndl * sunVis * sunI * 3.0;
  let skyAmb = mix(R_.skyHorizon.rgb, R_.skyZenith.rgb, 0.5 + 0.5 * n.y) * (0.45 + 0.45 * cloud);
  let bounce = albedo * albedo * 0.35 * (1.0 - n.y) * sunI;
  var col = albedo * (direct + skyAmb * ao * ao * 0.8) + bounce * ao;
  // Bluish fill in snow shadows; soft sparkle in sun.
  col += snowCov * vec3f(0.02, 0.05, 0.10) * (1.0 - sunVis) * ao;
  let V = normalize(R_.camPos.xyz - wp);
  let Hh = normalize(L + V);
  col += snowCov * R_.sunColor.rgb * pow(max(dot(n, Hh), 0.0), 60.0) * 0.25 * sunVis * sunI;

  col = applyHaze(col, wp);
  var outc = tonemap(col);
  // --- Overlay, blended in display space so colours match the legend.
  let ov = overlay(i32(R_.skyZenith.w), i.m0, i.m1);
  if (i32(R_.skyZenith.w) > 0) {
    // Mute the natural colours so the overlay reads clearly.
    let g = dot(outc, vec3f(0.3, 0.55, 0.15));
    outc = mix(outc, vec3f(g) * 0.9 + 0.05, 0.6);
  }
  if (ov.a > 0.0) {
    let shade = 0.6 + 0.4 * (ndl * sunVis * 0.8 + 0.2) * ao;
    outc = mix(outc, ov.rgb * shade, ov.a);
  }
  // Optional faint contour lines every 100 m for reading heights.
  let fw = fwidth(ground);
  if (R_.misc.w > 0.5) {
    let cl = 1.0 - smoothstep(0.0, fw * 1.2, abs(fract(ground / 100.0 + 0.5) - 0.5) * 100.0);
    outc = mix(outc, outc * 0.5, cl * 0.6);
  }
  return vec4f(outc, 1.0);
}`;

// Sides of the terrain block, showing soil over bedrock in cross-section.
export const SKIRT = UNIFORMS + COMMON + /* wgsl */ `
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
struct VO { @builtin(position) pos: vec4f, @location(0) wpos: vec3f, @location(1) info: vec3f, @location(2) nrm: vec3f };
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
  o.nrm = nrm;
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
  // Soil layer sits on top of bedrock (exaggerated a little so thin soils stay visible).
  if (y > b - 0.3) { c = R_.soilC.rgb * 0.9; }
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
@group(0) @binding(7) var<storage, read> light: array<vec2f>;
@group(0) @binding(8) var<storage, read> snowSWE: array<f32>;
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
  o.e = vec4f(L.x, L.y, snowSWE[i], gs);
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
