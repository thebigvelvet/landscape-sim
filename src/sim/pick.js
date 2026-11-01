// Pixel-accurate picking of the 3D terrain (round 2): which grid cell is under the mouse?
//
// The ray through the pixel is built from the SAME float32 inverse view-projection matrix the
// frame was drawn with, then intersected on the GPU with the SAME triangle mesh the terrain shader
// draws: vertex heights (bedrock + soil + snow / 0.33) x vertical exaggeration, and the same
// alternating diagonal per cell. So the hit is exact on steep terrain, with any height
// exaggeration, and with fresh snow or erosion that a CPU copy would not know about yet.
//
// GPU work: one workgroup of 256 threads. The ray's path across the grid (in grid units) is split
// into 256 equal pieces; each thread walks the cells of its piece with a 2D DDA and tests both
// triangles of each cell (Moller-Trumbore); a workgroup min-reduction keeps the nearest hit.
// Cost: ~10 cells per thread at 1024^2, well under 0.1 ms. The 16-byte result is read back
// asynchronously, so picking never stalls the frame loop.

const PICK_WGSL = /* wgsl */`
struct PU { o : vec4<f32>, d : vec4<f32>, n : vec4<u32> };   // o = (gx, gy, Y, T), d = (dgx, dgy, dY, vex), n.x = N
@group(0) @binding(0) var<uniform> U : PU;
@group(0) @binding(1) var<storage, read> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> snowSWE : array<f32>;
@group(0) @binding(4) var<storage, read_write> outp : array<vec4<f32>>;
var<workgroup> best : array<f32, 256>;

fn H(x : i32, y : i32) -> f32 {
  let n = i32(U.n.x);
  let i = u32(clamp(y, 0, n - 1) * n + clamp(x, 0, n - 1));
  return (bedrock[i] + soil[i] + snowSWE[i] / 0.33) * U.d.w;
}
// Moller-Trumbore, returns t or 1e30
fn tri(o : vec3<f32>, d : vec3<f32>, a : vec3<f32>, b : vec3<f32>, c : vec3<f32>) -> f32 {
  let e1 = b - a; let e2 = c - a;
  let p = cross(d, e2);
  let det = dot(e1, p);
  if (abs(det) < 1e-12) { return 1e30; }
  let inv = 1.0 / det;
  let s = o - a;
  let u = dot(s, p) * inv;
  if (u < -1e-5 || u > 1.00001) { return 1e30; }
  let q = cross(s, e1);
  let v = dot(d, q) * inv;
  if (v < -1e-5 || u + v > 1.00001) { return 1e30; }
  let t = dot(e2, q) * inv;
  return select(1e30, t, t >= -1e-4);
}
fn cellHit(x : i32, y : i32, o : vec3<f32>, d : vec3<f32>) -> f32 {
  let n = i32(U.n.x);
  if (x < 0 || y < 0 || x > n - 2 || y > n - 2) { return 1e30; }
  let fx = f32(x); let fy = f32(y);
  // vertex layout matches the terrain shader: (grid x, grid y, height)
  let a = vec3<f32>(fx, fy, H(x, y));
  let b = vec3<f32>(fx + 1.0, fy, H(x + 1, y));
  let c = vec3<f32>(fx, fy + 1.0, H(x, y + 1));
  let e = vec3<f32>(fx + 1.0, fy + 1.0, H(x + 1, y + 1));
  // same diagonal choice as Renderer.setWorld's index buffer
  if (((x + y) & 1) == 1) { return min(tri(o, d, a, c, b), tri(o, d, b, c, e)); }
  return min(tri(o, d, a, c, e), tri(o, d, a, e, b));
}

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_index) li : u32) {
  let o = U.o.xyz;
  let d = U.d.xyz;
  let T = U.o.w;
  let ta = T * f32(li) / 256.0;
  let tb = T * f32(li + 1u) / 256.0;
  var tBest = 1e30;
  // 2D DDA over the grid cells the ray's footprint crosses in [ta, tb]
  let p0 = o.xy + d.xy * ta;
  var cx = i32(floor(p0.x)); var cy = i32(floor(p0.y));
  let sx = select(-1, 1, d.x >= 0.0); let sy = select(-1, 1, d.y >= 0.0);
  let idx = select(1e30, abs(1.0 / d.x), abs(d.x) > 1e-12);
  let idy = select(1e30, abs(1.0 / d.y), abs(d.y) > 1e-12);
  var tmx = select(1e30, ((f32(cx) + select(0.0, 1.0, d.x >= 0.0)) - o.x) / d.x, abs(d.x) > 1e-12);
  var tmy = select(1e30, ((f32(cy) + select(0.0, 1.0, d.y >= 0.0)) - o.y) / d.y, abs(d.y) > 1e-12);
  for (var k = 0; k < 96; k++) {
    // also test the neighbour across each axis: covers rays that run exactly along a grid line
    tBest = min(tBest, cellHit(cx, cy, o, d));
    let tn = min(tmx, tmy);
    if (tn > tb) { break; }
    if (tmx < tmy) { cx += sx; tmx += idx; } else { cy += sy; tmy += idy; }
  }
  best[li] = tBest;
  workgroupBarrier();
  for (var off = 128u; off > 0u; off = off >> 1u) {
    if (li < off) { best[li] = min(best[li], best[li + off]); }
    workgroupBarrier();
  }
  if (li == 0u) {
    let t = best[0];
    if (t < 1e29) {
      let p = o + d * t;
      outp[0] = vec4<f32>(t, p.x, p.y, p.z);
    } else {
      outp[0] = vec4<f32>(-1.0, 0.0, 0.0, 0.0);
    }
  }
}
`;

/** Ray (in grid space: x, y in cells, Y in display metres) through NDC point, clipped to the grid. */
export function gridRay(ndcX, ndcY, invViewProj, N, cellSize) {
  const m = invViewProj;
  const unp = (z) => {
    const x = m[0] * ndcX + m[4] * ndcY + m[8] * z + m[12];
    const y = m[1] * ndcX + m[5] * ndcY + m[9] * z + m[13];
    const zz = m[2] * ndcX + m[6] * ndcY + m[10] * z + m[14];
    const w = m[3] * ndcX + m[7] * ndcY + m[11] * z + m[15];
    return [x / w, y / w, zz / w];
  };
  const a = unp(0), b = unp(1);
  const c = (N - 1) * 0.5;
  // world (X, Y, Z) -> grid (X/dx + c, Z/dx + c, Y)
  const o = [a[0] / cellSize + c, a[2] / cellSize + c, a[1]];
  const d = [(b[0] - a[0]) / cellSize, (b[2] - a[2]) / cellSize, b[1] - a[1]];
  // clip to the footprint box [0, N-1]^2 (slab method), t in units of the full near->far segment
  let t0 = 0, t1 = 1;
  for (let k = 0; k < 2; k++) {
    if (Math.abs(d[k]) < 1e-12) { if (o[k] < 0 || o[k] > N - 1) return null; continue; }
    let ta = (0 - o[k]) / d[k], tb = (N - 1 - o[k]) / d[k];
    if (ta > tb) [ta, tb] = [tb, ta];
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
  }
  if (t1 <= t0) return null;
  // start at the entry point (keeps the f32 numbers small on the GPU)
  return { o: [o[0] + d[0] * t0, o[1] + d[1] * t0, o[2] + d[2] * t0], d, T: t1 - t0, tEntry: t0 };
}

export class Picker {
  constructor() { this.pool = []; this.world = null; }

  init(device, world) {
    this.device = device; this.world = world;
    if (!this.pipeline) {
      const module = device.createShaderModule({ label: 'pick', code: PICK_WGSL });
      module.getCompilationInfo?.().then((info) => { for (const m of info.messages) if (m.type === 'error') console.error(`[pick] WGSL ${m.lineNum}:${m.linePos} ${m.message}`); });
      this.layout = device.createBindGroupLayout({
        label: 'pick',
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
          { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        ],
      });
      this.pipeline = device.createComputePipeline({ label: 'pick', layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: 'main' } });
      this.ub = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'pickU' });
    }
    const B = world.buffers;
    this.bg = device.createBindGroup({ layout: this.layout, entries: [this.ub, B.bedrock, B.soil, B.snowSWE, B.pick].map((b, i) => ({ binding: i, resource: { buffer: b } })) });
  }

  /**
   * Pick the terrain under NDC point (ndcX, ndcY) for the frame drawn with invViewProj and vertical
   * exaggeration vex. Resolves to { x, y } in grid cells (fractional), plus the display height, or
   * null for a miss (sky, outside the map).
   */
  async pick(ndcX, ndcY, invViewProj, vex) {
    const world = this.world;
    if (!world || !invViewProj) return null;
    const N = world.N;
    const ray = gridRay(ndcX, ndcY, invViewProj, N, world.cellSize);
    if (!ray) return null;
    const f = new Float32Array(12), u = new Uint32Array(f.buffer);
    f.set([ray.o[0], ray.o[1], ray.o[2], ray.T, ray.d[0], ray.d[1], ray.d[2], vex], 0);
    u[8] = N;
    const dev = this.device;
    dev.queue.writeBuffer(this.ub, 0, f);
    const st = this.pool.pop() || dev.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'pickStaging' });
    const enc = dev.createCommandEncoder({ label: 'pick' });
    const pass = enc.beginComputePass({ label: 'pick' });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bg); pass.dispatchWorkgroups(1);
    pass.end();
    enc.copyBufferToBuffer(world.buffers.pick, 0, st, 0, 16);
    dev.queue.submit([enc.finish()]);
    try {
      await st.mapAsync(GPUMapMode.READ);
    } catch (e) { st.destroy(); return null; }
    const r = new Float32Array(st.getMappedRange().slice(0));
    st.unmap();
    if (this.world === world) this.pool.push(st); else st.destroy();
    if (this.world !== world || !(r[0] >= 0)) return null;
    return { x: r[1], y: r[2], height: r[3] / vex, t: ray.tEntry + r[0] * 1 };
  }
}

/**
 * CPU reference (float64, brute force over every cell the footprint crosses) used by the tests to
 * check the GPU picker. H is a Float32Array of display heights (bedrock + soil + snow/0.33).
 */
export function pickReference(ndcX, ndcY, invViewProj, N, cellSize, H, vex) {
  const ray = gridRay(ndcX, ndcY, invViewProj, N, cellSize);
  if (!ray) return null;
  const { o, d, T } = ray;
  const h = (x, y) => H[Math.min(N - 1, Math.max(0, y)) * N + Math.min(N - 1, Math.max(0, x))] * vex;
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cr = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dt = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const tri = (a, b, c) => {
    const e1 = sub(b, a), e2 = sub(c, a), p = cr(d, e2), det = dt(e1, p);
    if (Math.abs(det) < 1e-15) return Infinity;
    const s = sub(o, a), uu = dt(s, p) / det;
    if (uu < -1e-9 || uu > 1 + 1e-9) return Infinity;
    const q = cr(s, e1), vv = dt(d, q) / det;
    if (vv < -1e-9 || uu + vv > 1 + 1e-9) return Infinity;
    const t = dt(e2, q) / det;
    return t >= -1e-9 ? t : Infinity;
  };
  let best = Infinity;
  // sample the footprint finely and test each visited cell and its 8 neighbours once
  const seen = new Set();
  const len = Math.hypot(d[0], d[1]) * T;
  const steps = Math.max(2, Math.ceil(len * 4));
  for (let k = 0; k <= steps; k++) {
    const t = (T * k) / steps;
    const cx = Math.floor(o[0] + d[0] * t), cy = Math.floor(o[1] + d[1] * t);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x > N - 2 || y > N - 2) continue;
      const key = y * N + x;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = [x, y, h(x, y)], b = [x + 1, y, h(x + 1, y)], c = [x, y + 1, h(x, y + 1)], e = [x + 1, y + 1, h(x + 1, y + 1)];
      const tt = ((x + y) & 1) ? Math.min(tri(a, c, b), tri(b, c, e)) : Math.min(tri(a, c, e), tri(a, e, b));
      if (tt < best) best = tt;
    }
  }
  if (!Number.isFinite(best)) return null;
  return { x: o[0] + d[0] * best, y: o[1] + d[1] * best, height: (o[2] + d[2] * best) / vex };
}
