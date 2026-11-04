// Terrain lighting precompute (compute shader): soft sun shadows by marching toward the sun
// across the height field, and horizon-based ambient occlusion. Also packs the groundwater fill,
// spring strength and the plant layers for the shaders, so the terrain vertex shader still binds
// only 8 storage buffers. world.light is vec4<u32> per cell:
//   x = pack2x16unorm(sun visibility, ambient occlusion)
//   y = pack2x16unorm(groundwater fill of the cell's capacity, spring code)   spring code s: 0 = none,
//       else discharge = 1e-5 * 10^(5 s) m/day (decode with springDecode in shaders.js)
//   z = pack4x8unorm(plant cover, woody share, burn severity, active fire)
//   w = pack4x8unorm(moisture memory, sediment bed thickness sqrt(t / 16 m), grain of the top 5 cm of beds, hash of its thickest bed)
//       (the last three come from a second pass, `dep`, so the main pass keeps its bindings)
import { WGSL_COMMON, makeKernels, dispatch } from './gpu.js';
import { PARAMS_WGSL } from '../sim/params.js';
import { strataWGSL, STRATA_PARAM_FIELDS } from '../sim/strata.js';

const CODE = /* wgsl */ `
struct U { N: u32, dx: f32, sunX: f32, sunZ: f32, tanElev: f32, vex: f32, snowDen: f32, gwMax: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
@group(0) @binding(3) var<storage, read> snowSWE: array<f32>;
@group(0) @binding(4) var<storage, read_write> light: array<vec4u>;
@group(0) @binding(5) var<storage, read> groundwater: array<f32>;
@group(0) @binding(6) var<storage, read> spring: array<f32>;
@group(0) @binding(7) var<storage, read> veg: array<f32>;
@group(0) @binding(8) var<storage, read> burn: array<f32>;
@group(0) @binding(9) var<storage, read> plant: array<vec4f>;
@group(0) @binding(10) var<storage, read> glacier: array<vec4f>;
// the sim's params (rock table), so the groundwater fill uses the same capacity as the sim
${PARAMS_WGSL}
@group(0) @binding(11) var<uniform> P: Params;
${strataWGSL((i) => `P.${STRATA_PARAM_FIELDS[i]}`, (k) => `P.stBeds[${k}]`)}
${WGSL_COMMON}
fn Hc(x: i32, y: i32, n: i32) -> f32 {
  let i = ix(x, y, n);
  return (bedrock[i] + soil[i] + snowSWE[i] / u.snowDen + glacier[i].x) * u.vex;
}
fn Hb(p: vec2f, n: i32) -> f32 {
  let f = floor(p);
  let t = p - f;
  let x = i32(f.x); let y = i32(f.y);
  let a = Hc(x, y, n); let b = Hc(x + 1, y, n); let c = Hc(x, y + 1, n); let d = Hc(x + 1, y + 1, n);
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) g: vec3u) {
  let n = i32(u.N);
  let x = i32(g.x); let y = i32(g.y);
  if (x >= n || y >= n) { return; }
  let p0 = vec2f(f32(x), f32(y));
  let h0 = Hc(x, y, n) + 0.5;
  // Soft shadow.
  let dir = vec2f(u.sunX, u.sunZ);
  var vis = 1.0;
  var t = 1.0;
  for (var k = 0; k < 48; k++) {
    let p = p0 + dir * t;
    if (p.x < 0.0 || p.y < 0.0 || p.x > f32(n - 1) || p.y > f32(n - 1)) { break; }
    let rayH = h0 + t * u.dx * u.tanElev;
    let hs = Hb(p, n);
    let s = (rayH - hs) / (t * u.dx * 0.07 + 2.0);
    vis = min(vis, clamp(s + 0.15, 0.0, 1.0));
    if (vis <= 0.0) { break; }
    t = t * 1.12 + 0.6;
  }
  // Horizon-based ambient occlusion over 8 directions and 5 radii.
  var occ = 0.0;
  for (var d = 0; d < 8; d++) {
    let a = f32(d) * 0.785398 + 0.39;
    let dv = vec2f(cos(a), sin(a));
    var maxT = 0.0;
    var r = 1.5;
    for (var k = 0; k < 6; k++) {
      let p = clamp(p0 + dv * r, vec2f(0.0), vec2f(f32(n - 1)));
      let dh = Hb(p, n) - h0 + 0.5;
      maxT = max(maxT, dh / (r * u.dx));
      r = r * 2.3;
    }
    occ += maxT / sqrt(1.0 + maxT * maxT);
  }
  let ao = clamp(1.0 - occ / 8.0 * 1.1, 0.0, 1.0);
  let i = ix(x, y, n);
  // = gwCapRock() in sim/common.js: fissured limestone (karst) holds up to 5x more
  var sol = 0.0;
  if (P.strataOn > 0.5) { sol = stRock(bedrock[i], vec2f(f32(x), f32(y))).sol; }
  let cap = u.gwMax * (0.15 + 0.85 * min(max(soil[i], 0.0), 2.0)) * (1.0 + 4.0 * min(max(sol, 0.0), 1.0));
  let sp = finiteOr(spring[i], 0.0);
  let spc = select(0.0, clamp(log(max(sp, 1e-5) / 1e-5) / log(1e5), 0.004, 1.0), sp > 1e-5);
  let pl = plant[i];
  light[i] = vec4u(
    pack2x16unorm(vec2f(vis, ao)),
    pack2x16unorm(vec2f(clamp(finiteOr(groundwater[i] / max(cap, 1e-4), 0.0), 0.0, 1.0), spc)),
    pack4x8unorm(clamp(vec4f(finiteOr(veg[i], 0.0), finiteOr(pl.x, 0.0), finiteOr(burn[i], 0.0), finiteOr(pl.w, 0.0)), vec4f(0.0), vec4f(1.0))),
    pack4x8unorm(vec4f(clamp(finiteOr(pl.y, 0.0), 0.0, 1.0), 0.0, 0.0, 0.0)));
}`;

// Sediment bed summary for the terrain shader (sim/deposits.js stack layout).
const DEP_CODE = /* wgsl */ `
struct U { N: u32, dx: f32, sunX: f32, sunZ: f32, tanElev: f32, vex: f32, snowDen: f32, gwMax: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> deposit: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> light: array<vec4u>;
@compute @workgroup_size(16, 16)
fn dep(@builtin(global_invocation_id) id: vec3u) {
  let n = u.N;
  if (id.x >= n || id.y >= n) { return; }
  let i = id.y * n + id.x;
  let t = dot(deposit[4u * i], vec4f(1.0)) + dot(deposit[4u * i + 1u], vec4f(1.0));
  // the surface shows the top few cm, so the grain is that layer's thickness-weighted mix: a dusting
  // of blown sand over gravel or old wash beds only tints them; the hash is the thickest bed's there
  let a0 = deposit[4u * i]; let a1 = deposit[4u * i + 1u];
  let t0 = deposit[4u * i + 2u]; let t1 = deposit[4u * i + 3u];
  let th = array<f32, 8>(a0.x, a0.y, a0.z, a0.w, a1.x, a1.y, a1.z, a1.w);
  let tgs = array<f32, 8>(t0.x, t0.y, t0.z, t0.w, t1.x, t1.y, t1.z, t1.w);
  var left = 0.05;
  var gs = 0.0; var ws = 0.0; var wBest = -1.0; var tg = tgs[0];
  for (var k = 0; k < 8; k++) {
    let w = min(max(th[k], 0.0), left);
    if (w <= 0.0) { break; }
    gs += w * fract(tgs[k]) / 0.99; ws += w; left -= w;
    if (w > wBest) { wBest = w; tg = tgs[k]; }
  }
  let grain = select(fract(tgs[0]) / 0.99, gs / ws, ws > 0.0);
  let h = fract(sin(floor(tg) * 12.9898 + 4.1) * 43758.547);   // = bedHash() in shaders.js
  let L = light[i];
  let m = unpack4x8unorm(L.w).x;
  let tt = select(0.0, t, t == t && t < 1e6);
  light[i] = vec4u(L.x, L.y, L.z, pack4x8unorm(clamp(vec4f(m, sqrt(tt / 16.0), grain, h), vec4f(0.0), vec4f(1.0))));
}`;

export class Lighting {
  constructor(device, world) {
    this.device = device;
    this.world = world;
    this.k = makeKernels(device, 'lighting', CODE, ['uniform', 'read', 'read', 'read', 'storage', 'read', 'read', 'read', 'read', 'read', 'read', 'uniform'], ['main']);
    this.ub = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bg = this.k.bind([this.ub, world.bedrock, world.soil, world.snowSWE, world.light, world.groundwater, world.spring, world.veg, world.burn, world.plant, world.glacier, world.params.buffer]);
    this.data = new ArrayBuffer(32);
    this.kd = makeKernels(device, 'lightingDep', DEP_CODE, ['uniform', 'read', 'storage'], ['dep']);
    this.bgd = this.kd.bind([this.ub, world.deposit, world.light]);
  }
  update(encoder, sunDir, vex, gwMax = 0.25) {
    const f = new Float32Array(this.data), u = new Uint32Array(this.data);
    const hl = Math.hypot(sunDir[0], sunDir[2]) || 1;
    u[0] = this.world.N;
    f[1] = this.world.cellSize;
    f[2] = sunDir[0] / hl;
    f[3] = sunDir[2] / hl;
    f[4] = sunDir[1] / hl;
    f[5] = vex;
    f[6] = 0.33;
    f[7] = gwMax;
    this.device.queue.writeBuffer(this.ub, 0, this.data);
    dispatch(encoder, this.k.pipes.main, this.bg, this.world.N);
    dispatch(encoder, this.kd.pipes.dep, this.bgd, this.world.N);
  }
}
