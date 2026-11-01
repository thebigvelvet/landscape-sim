// Terrain lighting precompute (compute shader): soft sun shadows by marching toward the sun
// across the height field, and horizon-based ambient occlusion. Also packs the groundwater fill and
// spring strength for the shaders. Written to world.light (vec4: sun vis, ao, groundwater fill, spring).
import { WGSL_COMMON, makeKernels, dispatch } from './gpu.js';

const CODE = /* wgsl */ `
struct U { N: u32, dx: f32, sunX: f32, sunZ: f32, tanElev: f32, vex: f32, snowDen: f32, gwMax: f32 };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> bedrock: array<f32>;
@group(0) @binding(2) var<storage, read> soil: array<f32>;
@group(0) @binding(3) var<storage, read> snowSWE: array<f32>;
@group(0) @binding(4) var<storage, read_write> light: array<vec4f>;
@group(0) @binding(5) var<storage, read> groundwater: array<f32>;
@group(0) @binding(6) var<storage, read> spring: array<f32>;
${WGSL_COMMON}
fn Hc(x: i32, y: i32, n: i32) -> f32 {
  let i = ix(x, y, n);
  return (bedrock[i] + soil[i] + snowSWE[i] / u.snowDen) * u.vex;
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
  light[i] = vec4f(vis, ao, clamp(groundwater[i] / max(u.gwMax, 1e-3), 0.0, 1.0), finiteOr(spring[i], 0.0));
}`;

export class Lighting {
  constructor(device, world) {
    this.device = device;
    this.world = world;
    this.k = makeKernels(device, 'lighting', CODE, ['uniform', 'read', 'read', 'read', 'storage', 'read', 'read'], ['main']);
    this.ub = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bg = this.k.bind([this.ub, world.bedrock, world.soil, world.snowSWE, world.light, world.groundwater, world.spring]);
    this.data = new ArrayBuffer(32);
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
  }
}
