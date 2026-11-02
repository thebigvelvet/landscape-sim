// Sculpting: hand-shaping the ground with brushes (raise, lower, smooth, flatten, carve a channel)
// plus undo. Works while the simulation is paused or running.
//
// Every change to the ground is ALSO added to initHeight. initHeight is the reference for the
// erosion/deposition overlay, the solids balance (stats.js) and the fixed base level at the map
// edge (water.js), so moving it with the brush keeps all three meaning "what nature did since
// load": a raised hill does not show up as deposition, the solids books stay balanced, and a dam
// built on the map edge raises that edge's base level with it.
//
// Because nothing else ever writes initHeight, the change made by a stroke is exactly
// initHeight(after) - initHeight(before). Undo puts that difference back (applyDelta), so it removes
// the sculpting and keeps any erosion that happened during or after the stroke.
//
// Each dab is its own small command buffer with its own uniform buffer, dispatched only over the
// brush's bounding box. It is queue-ordered between simulation batches and never touches the shared
// ParamBlock.
import { WG } from './common.js';

export const SCULPT_OPS = ['raise', 'lower', 'smooth', 'flatten', 'channel'];
export const SCULPT_DEFAULTS = {
  raiseM: 1.0,        // metres per dab at the centre (normal strength); a held brush dabs ~33x/s
  smoothK: 0.5,       // fraction of the way to the 3x3 mean per dab
  flattenK: 0.25,     // fraction of the way to the target height per dab
  channelDepth: 6,    // metres below the original ground along the stroke (normal strength)
  undoDepth: 20,      // strokes kept for undo
};
const OP = { add: 0, smooth: 1, flatten: 2, channel: 3, delta: 4, copy: 5 };

const SCULPT_WGSL = /* wgsl */`
struct U {
  N : u32, op : u32, ox : i32, oy : i32,
  w : u32, h : u32, pad0 : u32, pad1 : u32,
  cx : f32, cy : f32, r : f32, amt : f32,
  ax : f32, ay : f32, bx : f32, by : f32,
  za : f32, zb : f32, zt : f32, k : f32,   // zt: flatten target height
};
@group(0) @binding(0) var<uniform> u : U;
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> initHeight : array<f32>;
@group(0) @binding(4) var<storage, read_write> scratch : array<f32>;

fn ix(x : i32, y : i32) -> u32 { return u32(y) * u.N + u32(x); }
// smooth bell: 1 at the centre, 0 at the rim, flat-topped enough that strokes blend
fn bell(d : f32, r : f32) -> f32 { let q = clamp(d / max(r, 1e-3), 0.0, 1.0); let t = 1.0 - q * q; return t * t; }

// Move the ground by dz: onto/off the bedrock (soil thickness kept), and initHeight with it.
fn moveGround(i : u32, dz : f32) {
  let b = bedrock[i];
  let nb = b + dz;
  bedrock[i] = nb;
  initHeight[i] = initHeight[i] + (nb - b);   // the exact f32 change, so the books stay exact
}

@compute @workgroup_size(${WG}, ${WG})
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  if (gid.x >= u.w || gid.y >= u.h) { return; }
  let x = u.ox + i32(gid.x); let y = u.oy + i32(gid.y);
  let n = i32(u.N);
  if (x < 0 || y < 0 || x >= n || y >= n) { return; }
  let i = ix(x, y);
  let p = vec2<f32>(f32(x), f32(y));
  if (u.op == ${OP.copy}u) { scratch[i] = bedrock[i] + soil[i]; return; }
  if (u.op == ${OP.delta}u) { let d = scratch[i]; if (d != 0.0) { moveGround(i, d); } return; }
  let ground = bedrock[i] + soil[i];
  if (u.op == ${OP.channel}u) {
    // capsule around the segment a -> b; the bed follows the ORIGINAL ground (za..zb, sampled at the
    // start of the stroke) minus the depth, with a U-shaped cross-section. Only ever cuts down, and
    // cutting to a fixed bed is idempotent, so going over the same spot twice does not dig deeper.
    let a = vec2<f32>(u.ax, u.ay); let ab = vec2<f32>(u.bx, u.by) - a;
    let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
    let d = length(p - (a + ab * t));
    if (d > u.r) { return; }
    let q = d / u.r;
    let bed = mix(u.za, u.zb, t) - u.amt * (1.0 - q * q);
    if (ground <= bed) { return; }
    var dz = bed - ground;
    // strip the soil in the middle of the bed first (a fresh cut shows gravel and rock)
    let so = soil[i];
    let take = min(so, -dz * (1.0 - q));
    soil[i] = so - take;
    initHeight[i] = initHeight[i] - take;
    dz = dz + take;
    moveGround(i, dz);
    return;
  }
  let f = bell(length(p - vec2<f32>(u.cx, u.cy)), u.r);
  if (f <= 0.0) { return; }
  if (u.op == ${OP.add}u) { moveGround(i, u.amt * f); return; }
  if (u.op == ${OP.flatten}u) { moveGround(i, (u.zt - ground) * clamp(u.k * f, 0.0, 1.0)); return; }
  if (u.op == ${OP.smooth}u) {
    var s = 0.0; var c = 0.0;
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let xx = x + dx; let yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= n || yy >= n) { continue; }
        s += scratch[ix(xx, yy)]; c += 1.0;
      }
    }
    moveGround(i, (s / c - ground) * clamp(u.k * f, 0.0, 1.0));
  }
}
`;

export class Sculptor {
  constructor() { this.undoStack = []; this.stroke = null; }

  init(device, world) {
    this.device = device; this.world = world;
    this.undoStack = []; this.stroke = null;
    if (!this.pipeline) {
      const entries = [{ binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } }];
      for (let b = 1; b <= 4; b++) entries.push({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
      this.layout = device.createBindGroupLayout({ label: 'sculpt', entries });
      const module = device.createShaderModule({ label: 'sculpt', code: SCULPT_WGSL });
      module.getCompilationInfo?.().then((info) => {
        for (const m of info.messages) if (m.type === 'error') console.error(`[sculpt] WGSL ${m.lineNum}:${m.linePos} ${m.message}`);
      });
      this.pipeline = device.createComputePipeline({ label: 'sculpt', layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout] }), compute: { module, entryPoint: 'main' } });
      this.raw = new ArrayBuffer(80);
      this.u = new Uint32Array(this.raw); this.i = new Int32Array(this.raw); this.f = new Float32Array(this.raw);
    }
    // a small ring of uniform buffers so several dabs can be queued in one frame
    this.ring = Array.from({ length: 8 }, () => device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'sculpt.u' }));
    const B = world.buffers;
    this.bgs = this.ring.map((ub) => device.createBindGroup({ label: 'sculpt', layout: this.layout, entries: [ub, B.bedrock, B.soil, B.initHeight, B.sculptScratch].map((b, k) => ({ binding: k, resource: { buffer: b } })) }));
    this.slot = 0;
  }

  reset() { this.undoStack = []; this.stroke = null; }

  // one dispatch over the box [x0, x1] x [y0, y1] (inclusive, clipped to the map)
  _run(enc, op, box, fields = {}) {
    const N = this.world.N;
    const x0 = Math.max(0, Math.floor(box[0])), y0 = Math.max(0, Math.floor(box[1]));
    const x1 = Math.min(N - 1, Math.ceil(box[2])), y1 = Math.min(N - 1, Math.ceil(box[3]));
    if (x1 < x0 || y1 < y0) return;
    const { u, i, f } = this;
    u[0] = N; u[1] = op; i[2] = x0; i[3] = y0; u[4] = x1 - x0 + 1; u[5] = y1 - y0 + 1;
    const vals = [fields.cx, fields.cy, fields.r, fields.amt, fields.ax, fields.ay, fields.bx, fields.by, fields.za, fields.zb, fields.target, fields.k];
    vals.forEach((v, k) => { f[8 + k] = Number.isFinite(v) ? v : 0; });
    const s = this.slot; this.slot = (this.slot + 1) % this.ring.length;
    this.device.queue.writeBuffer(this.ring[s], 0, this.raw);
    const pass = enc.beginComputePass({ label: `sculpt.${op}` });
    pass.setPipeline(this.pipeline); pass.setBindGroup(0, this.bgs[s]);
    pass.dispatchWorkgroups(Math.ceil(u[4] / WG), Math.ceil(u[5] / WG));
    pass.end();
    // each dispatch is submitted on its own so its uniform write lands before the next one
    this.device.queue.submit([enc.finish()]);
  }

  /**
   * One dab. op: raise | lower | smooth | flatten | channel. x, y, radius in cells; intensity
   * multiplies the default rate. flatten needs `target` (ground height, m above datum); channel needs
   * `ax, ay` (previous point) and `za, zb` (original ground at a and at x, y).
   * Returns the box that was touched.
   */
  dab(op, o) {
    const r = Math.max(1, +o.radius || 10), I = Math.max(0.05, +o.intensity || 1);
    const x = +o.x, y = +o.y;
    let box = [x - r, y - r, x + r, y + r];
    const D = SCULPT_DEFAULTS;
    const enc = () => this.device.createCommandEncoder({ label: 'sculpt' });
    if (op === 'raise' || op === 'lower') {
      this._run(enc(), OP.add, box, { cx: x, cy: y, r, amt: (op === 'raise' ? 1 : -1) * D.raiseM * I });
    } else if (op === 'smooth') {
      this._run(enc(), OP.copy, [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]);
      this._run(enc(), OP.smooth, box, { cx: x, cy: y, r, k: D.smoothK * I });
    } else if (op === 'flatten') {
      this._run(enc(), OP.flatten, box, { cx: x, cy: y, r, target: +o.target, k: D.flattenK * I });
    } else if (op === 'channel') {
      const ax = o.ax ?? x, ay = o.ay ?? y;
      const w = Math.max(1, r * 0.5);             // a channel is narrower than the ring
      box = [Math.min(ax, x) - w, Math.min(ay, y) - w, Math.max(ax, x) + w, Math.max(ay, y) + w];
      this._run(enc(), OP.channel, box, { ax, ay, bx: x, by: y, r: w, amt: D.channelDepth * I, za: +o.za, zb: +o.zb });
    } else throw new Error(`unknown sculpt op '${op}' (use ${SCULPT_OPS.join(', ')})`);
    if (this.stroke) {
      const b = this.stroke.box;
      b[0] = Math.min(b[0], box[0] - 1); b[1] = Math.min(b[1], box[1] - 1); b[2] = Math.max(b[2], box[2] + 1); b[3] = Math.max(b[3], box[3] + 1);
    }
    return box;
  }

  /** Start an undoable stroke: snapshot initHeight BEFORE any dab of the stroke is queued. */
  beginStroke(readLayer) {
    if (this.stroke) this.endStroke();
    this.stroke = { box: [Infinity, Infinity, -Infinity, -Infinity], snap: readLayer('initHeight'), N: this.world.N };
  }

  /** Finish the stroke: keep only the part of the snapshot the stroke touched. */
  async endStroke() {
    const st = this.stroke; this.stroke = null;
    if (!st || !(st.box[2] >= st.box[0])) return;
    const N = st.N;
    const x0 = Math.max(0, Math.floor(st.box[0])), y0 = Math.max(0, Math.floor(st.box[1]));
    const x1 = Math.min(N - 1, Math.ceil(st.box[2])), y1 = Math.min(N - 1, Math.ceil(st.box[3]));
    const entry = { N, x0, y0, x1, y1, before: null };
    this.undoStack.push(entry);
    if (this.undoStack.length > SCULPT_DEFAULTS.undoDepth) this.undoStack.shift();
    const full = await st.snap;
    const w = x1 - x0 + 1, before = new Float32Array(w * (y1 - y0 + 1));
    for (let y = y0; y <= y1; y++) before.set(full.subarray(y * N + x0, y * N + x1 + 1), (y - y0) * w);
    entry.before = before;
  }

  get canUndo() { return this.undoStack.length > 0; }

  /** Undo the last stroke. Returns false if there is nothing to undo. */
  async undo(readLayer) {
    const e = this.undoStack.pop();
    if (!e || e.N !== this.world.N) return false;
    while (!e.before) await new Promise((r) => setTimeout(r, 10));   // its snapshot is still on the way
    const N = e.N, w = e.x1 - e.x0 + 1;
    const now = await readLayer('initHeight');
    const delta = new Float32Array(N * N);
    for (let y = e.y0; y <= e.y1; y++) {
      for (let x = e.x0; x <= e.x1; x++) delta[y * N + x] = e.before[(y - e.y0) * w + (x - e.x0)] - now[y * N + x];
    }
    this.device.queue.writeBuffer(this.world.buffers.sculptScratch, 0, delta);
    this._run(this.device.createCommandEncoder({ label: 'sculpt.undo' }), OP.delta, [e.x0, e.y0, e.x1, e.y1]);
    return { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 };
  }
}

export const sculptor = new Sculptor();
export default sculptor;
