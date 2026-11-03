// GPU reductions for auditing, designed so the CPU never stalls the GPU:
//
//  * Flux log (every frame, on GPU only): the per-cell accumulator `acc` (precip, outflow, evap,
//    sediment out; metres) is reduced by 256 workgroups to 256 partials, then by one workgroup to a
//    single vec4 written into a 4096-entry ring `fluxLog[frame % 4096]`, and `acc` is zeroed.
//    The CPU copies the ring only occasionally (async mapAsync) and sums the new entries in float64,
//    so cumulative totals never suffer f32 round-off no matter how long the run is.
//  * State stats (on demand / every ~0.5 s): 256 partials of 15 floats (sums of the stores,
//    min/max height, max depth, NaN count, glacier ice and ice-covered cells) -> 12 KB async readback -> float64 sums on the CPU.
import { COMMON_WGSL, makeKernel } from './common.js';
import { STAT_GROUPS, STAT_STRIDE, LOG_SIZE } from '../world.js';

const STATS_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> water : array<f32>;
@group(0) @binding(4) var<storage, read> sediment : array<f32>;
@group(0) @binding(5) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(6) var<storage, read> groundwater : array<f32>;
@group(0) @binding(7) var<storage, read_write> partials : array<f32>;
@group(0) @binding(8) var<storage, read> initHeight : array<f32>;
@group(0) @binding(9) var<storage, read> glacier : array<vec4<f32>>;

var<workgroup> sh : array<array<f32, 15>, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li : u32, @builtin(workgroup_id) wg : vec3<u32>) {
  let cells = P.N * P.N;
  var a : array<f32, 15>;
  for (var k = 0u; k < 15u; k++) { a[k] = 0.0; }
  a[6] = 1e30; a[7] = -1e30; a[11] = 1e30; a[12] = -1e30;
  var i = wg.x * 256u + li;
  let stride = ${STAT_GROUPS}u * 256u;
  loop {
    if (i >= cells) { break; }
    let w = water[i]; let s = sediment[i]; let so = soil[i]; let b = bedrock[i];
    let sn = snowSWE[i]; let g = groundwater[i]; let gl = glacier[i];
    let bad = isBad(w) || isBad(s) || isBad(so) || isBad(b) || isBad(sn) || isBad(g) || isBad(gl.x) || isBad(gl.y);
    if (bad) {
      a[9] += 1.0;
    } else {
      a[0] += w; a[1] += s; a[2] += so; a[3] += b; a[4] += sn; a[5] += g;
      let z = b + so;
      a[6] = min(a[6], z); a[7] = max(a[7], z); a[8] = max(a[8], w);
      let dz = z - initHeight[i];
      a[10] += dz + s + gl.y + gl.w;   // solids change since load (small numbers -> precise); rock in the ice counts
      a[13] += gl.x; a[14] += select(0.0, 1.0, gl.x > 1.0);
      a[11] = min(a[11], dz); a[12] = max(a[12], dz);
    }
    i += stride;
  }
  sh[li] = a;
  workgroupBarrier();
  for (var off = 128u; off > 0u; off = off >> 1u) {
    if (li < off) {
      var m = sh[li];
      let o = sh[li + off];
      for (var k = 0u; k < 6u; k++) { m[k] += o[k]; }
      m[6] = min(m[6], o[6]); m[7] = max(m[7], o[7]); m[8] = max(m[8], o[8]); m[9] += o[9]; m[10] += o[10]; m[11] = min(m[11], o[11]); m[12] = max(m[12], o[12]); m[13] += o[13]; m[14] += o[14];
      sh[li] = m;
    }
    workgroupBarrier();
  }
  if (li == 0u) {
    let base = wg.x * ${STAT_STRIDE}u;
    for (var k = 0u; k < 15u; k++) { partials[base + k] = sh[0][k]; }
  }
}
`;

const ACC_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> acc : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> partials : array<vec4<f32>>;
var<workgroup> sh : array<vec4<f32>, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li : u32, @builtin(workgroup_id) wg : vec3<u32>) {
  let cells = P.N * P.N;
  var a = vec4<f32>(0.0);
  var i = wg.x * 256u + li;
  let stride = ${STAT_GROUPS}u * 256u;
  loop {
    if (i >= cells) { break; }
    a += acc[i];
    acc[i] = vec4<f32>(0.0);
    i += stride;
  }
  sh[li] = a;
  workgroupBarrier();
  for (var off = 128u; off > 0u; off = off >> 1u) {
    if (li < off) { sh[li] += sh[li + off]; }
    workgroupBarrier();
  }
  if (li == 0u) { partials[wg.x] = sh[0]; }
}
`;

const ACC_FINAL_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> partials : array<vec4<f32>>;
@group(0) @binding(2) var<storage, read_write> fluxLog : array<vec4<f32>>;
var<workgroup> sh : array<vec4<f32>, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li : u32) {
  sh[li] = partials[li];
  workgroupBarrier();
  for (var off = 128u; off > 0u; off = off >> 1u) {
    if (li < off) { sh[li] += sh[li + off]; }
    workgroupBarrier();
  }
  if (li == 0u) { fluxLog[P.frame % P.logSize] = sh[0]; }
}
`;

// Plant cover statistics: sum of cover, cells with cover >= 0.3, cells with burn >= 0.1, sum of
// woody cover (cover x woody share). 256 partial vec4s, summed on the CPU.
const PLANT_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read> veg : array<f32>;
@group(0) @binding(2) var<storage, read> burn : array<f32>;
@group(0) @binding(3) var<storage, read> plant : array<vec4<f32>>;
@group(0) @binding(4) var<storage, read_write> partials : array<vec4<f32>>;
var<workgroup> sh : array<vec4<f32>, 256>;
@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li : u32, @builtin(workgroup_id) wg : vec3<u32>) {
  let cells = P.N * P.N;
  var a = vec4<f32>(0.0);
  var i = wg.x * 256u + li;
  let stride = ${STAT_GROUPS}u * 256u;
  loop {
    if (i >= cells) { break; }
    let v = finite(veg[i]);
    a += vec4<f32>(v, select(0.0, 1.0, v >= 0.3), select(0.0, 1.0, finite(burn[i]) >= 0.1), v * finite(plant[i].x));
    i += stride;
  }
  sh[li] = a;
  workgroupBarrier();
  for (var off = 128u; off > 0u; off = off >> 1u) {
    if (li < off) { sh[li] += sh[li + off]; }
    workgroupBarrier();
  }
  if (li == 0u) { partials[wg.x] = sh[0]; }
}
`;

export class Stats {
  constructor(device, world) {
    this.device = device; this.world = world;
    const B = world.buffers, prm = world.params.buffer;
    this.ks = makeKernel(device, 'stats', STATS_WGSL, ['r', 'r', 'r', 'r', 'r', 'r', 'rw', 'r', 'r']);
    this.ka = makeKernel(device, 'acc.reduce', ACC_WGSL, ['rw', 'rw']);
    this.kf = makeKernel(device, 'acc.final', ACC_FINAL_WGSL, ['r', 'rw']);
    this.sBG = this.ks.bind(prm, [B.bedrock, B.soil, B.water, B.sediment, B.snowSWE, B.groundwater, B.statPartials, B.initHeight, B.glacier]);
    this.aBG = this.ka.bind(prm, [B.acc, B.accPartials]);
    this.fBG = this.kf.bind(prm, [B.accPartials, B.fluxLog]);
    this.kp = makeKernel(device, 'plant.stats', PLANT_WGSL, ['r', 'r', 'r', 'rw']);
    this.pBG = this.kp.bind(prm, [B.veg, B.burn, B.plant, B.plantPartials]);
    this.pool = [];
  }

  // per frame: fold acc into the log ring (2 dispatches)
  recordAccumulate(pass) {
    pass.setPipeline(this.ka.pipeline); pass.setBindGroup(0, this.aBG); pass.dispatchWorkgroups(STAT_GROUPS);
    pass.setPipeline(this.kf.pipeline); pass.setBindGroup(0, this.fBG); pass.dispatchWorkgroups(1);
  }

  _staging() {
    const size = STAT_GROUPS * STAT_STRIDE * 4 + LOG_SIZE * 16 + STAT_GROUPS * 16;
    return this.pool.pop() || this.device.createBuffer({ size, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'statsStaging' });
  }

  // Encode stats + log snapshot into its own submission and resolve with raw arrays. Never blocks
  // the render loop: the caller awaits a promise that resolves when the GPU gets there.
  async snapshot() {
    const dev = this.device, B = this.world.buffers;
    const st = this._staging();
    const enc = dev.createCommandEncoder({ label: 'stats' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.ks.pipeline); pass.setBindGroup(0, this.sBG); pass.dispatchWorkgroups(STAT_GROUPS);
    pass.setPipeline(this.kp.pipeline); pass.setBindGroup(0, this.pBG); pass.dispatchWorkgroups(STAT_GROUPS);
    pass.end();
    const pBytes = STAT_GROUPS * STAT_STRIDE * 4;
    enc.copyBufferToBuffer(B.statPartials, 0, st, 0, pBytes);
    enc.copyBufferToBuffer(B.fluxLog, 0, st, pBytes, LOG_SIZE * 16);
    enc.copyBufferToBuffer(B.plantPartials, 0, st, pBytes + LOG_SIZE * 16, STAT_GROUPS * 16);
    dev.queue.submit([enc.finish()]);
    await st.mapAsync(GPUMapMode.READ);
    const all = new Float32Array(st.getMappedRange().slice(0));
    st.unmap();
    this.pool.push(st);
    const part = all.subarray(0, STAT_GROUPS * STAT_STRIDE);
    const log = all.subarray(STAT_GROUPS * STAT_STRIDE, STAT_GROUPS * STAT_STRIDE + LOG_SIZE * 4);
    const pp = all.subarray(STAT_GROUPS * STAT_STRIDE + LOG_SIZE * 4);
    // float64 sums
    const out = { vegSum: 0, vegCovered: 0, burned: 0, woodySum: 0, water: 0, sediment: 0, soil: 0, bedrock: 0, snow: 0, groundwater: 0, minH: Infinity, maxH: -Infinity, maxWater: 0, nan: 0, solidsChange: 0, maxErosion: 0, maxDeposition: 0, ice: 0, iceCells: 0 };
    for (let gi = 0; gi < STAT_GROUPS; gi++) {
      const o = gi * STAT_STRIDE;
      out.water += part[o]; out.sediment += part[o + 1]; out.soil += part[o + 2]; out.bedrock += part[o + 3];
      out.snow += part[o + 4]; out.groundwater += part[o + 5];
      out.minH = Math.min(out.minH, part[o + 6]); out.maxH = Math.max(out.maxH, part[o + 7]);
      out.maxWater = Math.max(out.maxWater, part[o + 8]); out.nan += part[o + 9]; out.solidsChange += part[o + 10];
      out.maxErosion = Math.max(out.maxErosion, -part[o + 11]); out.maxDeposition = Math.max(out.maxDeposition, part[o + 12]);
      out.ice += part[o + 13]; out.iceCells += part[o + 14];
      for (let k = 0; k < 9; k++) if (!Number.isFinite(part[o + k]) && !(k === 6 || k === 7)) out.nan += 1;
    }
    for (let gi = 0; gi < STAT_GROUPS; gi++) {
      out.vegSum += pp[gi * 4]; out.vegCovered += pp[gi * 4 + 1]; out.burned += pp[gi * 4 + 2]; out.woodySum += pp[gi * 4 + 3];
    }
    return { state: out, log };
  }

  destroy() { for (const b of this.pool) b.destroy(); this.pool = []; }
}
