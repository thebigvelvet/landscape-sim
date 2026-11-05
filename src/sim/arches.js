// Natural arches and bridges in sandstone.
//
// The ground is a height field (one height per cell), so it cannot hold a hole with rock above it.
// Arches therefore live beside it as objects. When one forms, the cells under its opening are
// lowered to the opening's floor and the rock that spans the gap (the lintel) moves out of the
// height field into the arch's own store. The rest of the rock that was dug out falls as talus
// beside the fin. The renderer draws each lintel as a 3D span between its two abutments, whose top
// follows the live height of the abutment cells, so it wears down with the fin.
//
// Where they form (the real settings):
//   Fin arches (Arches National Park). Massive sandstone (eolian dune sandstone, thick fluvial
//   sandstone or arkose) cracked by a joint set wears into fins: narrow walls a few cells wide
//   and tens of metres high, running along the joints. A fin sitting on, or with, a soft bed of
//   mudstone or shale near its foot is undercut there: seepage and frost spall slabs off the soft
//   contact, and a window opens through the fin. Without a soft bed it happens much more rarely.
//   No joints, no fins, no arches: they only form on maps with joint sets (the Colorado Plateau).
//   Natural bridges (Natural Bridges National Monument). A stream entrenched in sandstone loops
//   round a meander so tightly that only a thin wall separates the two sides of the loop. The
//   stream breaks through the neck and the wall above stays as a bridge over the short cut; the
//   stream abandons the loop.
//
// Life of an arch: the opening grows (faster in rock that weathers faster) and widens one cell at
// a time while the fin goes on; the lintel thins as the opening rises and as its top wears down.
// When it is too thin for its span it collapses: its rock falls as talus into the opening and two
// buttresses are left standing. Real arches last tens to hundreds of thousands of years; here they
// run ARCH_SPEEDUP times faster, like the karst (sim/karst.js), so they come and go within a few
// tens of thousands of years at the fastest speed.
//
// Books: talus and fallen lintels are moved, never made: every edit is bedrock -> soil, and the
// lintels' rock is held in `store` (m3, float64), which the solids balance adds back.
import { makeKernel } from './common.js';
import { strataLayer } from './strata.js';

export const MAX_ARCHES = 64;
export const ARCH_SPEEDUP = 20;
const CHECK_YEARS = 250;          // how often the sim looks for new arches and ages the old ones
const MIN_WALL_MS = 350;          // and never more often than this in real time
const ARCH_ROCK = new Set(['eolian', 'massiveSand', 'arkose']);
export const ARCH_PARAMS = {
  pFin: 0.05,        // chance per candidate per thousand years (sped up), with a soft bed at its foot
  pBridge: 0.05,     // chance per meander neck per thousand years
  openRate: 0.12,    // m of opening growth per thousand years per unit of rock weathering, before speed-up
  finMinH: 8,        // m a fin must stand above the ground on both sides
  spacing: 6,        // cells between arches
};

const EDIT_WGSL = /* wgsl */`
struct Params { N : u32 };
@group(0) @binding(0) var<uniform> P : Params;
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read_write> soil : array<f32>;
@group(0) @binding(3) var<storage, read_write> edits : array<vec4<f32>>;
// edit = (cell, floor, talus m, cut flag): cut flag > 0 cuts the cell down to the absolute floor
// (rock above it and all soil, as of NOW, not as of the readback the plan came from), then talus is
// added as soil. The volume actually cut (m) is written back into .y for the books.
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let n = u32(edits[0].x);
  if (gid.x >= n) { return; }
  let e = edits[gid.x + 1u];
  let i = u32(e.x);
  if (i >= P.N * P.N) { return; }
  var cut = 0.0;
  if (e.w > 0.5) {
    let b = bedrock[i];
    if (b > e.y) { cut = b - e.y + soil[i]; bedrock[i] = e.y; soil[i] = 0.0; }
  }
  soil[i] = soil[i] + max(e.z, 0.0);
  edits[gid.x + 1u].y = cut;
}
`;
const MAX_EDITS = 8192;

export class Arches {
  constructor() { this.list = []; this.params = ARCH_PARAMS; this.reset(); }

  init(device, world) {
    if (this.world === world && this.k) return;
    this.device = device; this.world = world;
    // the kernel only needs N, so it has its own tiny uniform rather than the shared params block
    this.k ||= makeKernel(device, 'arches.edit', EDIT_WGSL, ['rw', 'rw', 'rw']);
    // these do not depend on the grid size, so a new world reuses them
    this.ub ||= device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'arches.ub' });
    device.queue.writeBuffer(this.ub, 0, new Uint32Array([world.N, 0, 0, 0]));
    this.editBuf ||= device.createBuffer({ size: (MAX_EDITS + 1) * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label: 'arches.edits' });
    this.bg = this.k.bind(this.ub, [world.buffers.bedrock, world.buffers.soil, this.editBuf]);
  }

  reset(seed = 1) {
    this.list = [];             // standing arches and bridges
    this.fallen = 0; this.formed = 0; this.bridgesFormed = 0;
    this.store = 0;             // m3 of rock held in the lintels (solids books)
    this.orphans = [];          // cut rock owed to arches that fell before the cut was confirmed
    // (an update still in flight keeps `busy` until it finishes; its gen check drops its result)
    this.lastDay = 0; this.lastWall = 0;
    this.rng = ((seed | 0) * 2654435761 + 12345) >>> 0;
    this.log = [];
    this._upload();
  }
  _rand() {
    let t = (this.rng = (this.rng + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  get standing() { return this.list.length; }
  get bridges() { return this.list.filter((a) => a.kind === 'bridge').length; }

  // Is an update due? (sim time and real time)
  due(sim) {
    if (!sim.strata || !sim.strataInfo || this.busy) return false;
    if (sim.day - this.lastDay < CHECK_YEARS * 365) return false;
    // the scan runs on the main thread: on big maps give the frame loop more room between scans
    const wall = MIN_WALL_MS * Math.max(1, (sim.world.N / 512) ** 2);
    return performance.now() - this.lastWall >= wall || sim.running;
  }

  // Look for new arches and age the standing ones. Reads the ground back from the GPU.
  update(sim) {
    if (this.busy) return this.busy;
    this.busy = this._update(sim).finally(() => { this.busy = null; });
    return this.busy;
  }

  async _update(sim) {
    const day = sim.day, gen = sim.gen;
    const dtKyr = Math.min((day - this.lastDay) / 365000, 5);
    this.lastDay = day; this.lastWall = performance.now();
    const T = sim.strataInfo;
    // only maps with arch-forming sandstone in the stack need the readback
    if (!T.beds.some((b) => ARCH_ROCK.has(b.type)) && !this.list.length) return;
    const [b, s, w] = await Promise.all(['bedrock', 'soil', 'water'].map((n) => sim.readLayer(n)));
    if (gen !== sim.gen) return;     // a new map was loaded meanwhile
    const N = sim.world.N, cs = sim.world.cellSize, A = cs * cs;
    const G = new Float32Array(N * N);
    for (let i = 0; i < N * N; i++) G[i] = b[i] + s[i];
    const ctx = { N, cs, A, b, s, w, G, T, edits: new Map() };
    const sandAt = (i) => {
      const x = i % N, y = (i / N) | 0;
      const bed = T.beds[strataLayer(b[i] - 0.5, x, y, T)];
      return bed && ARCH_ROCK.has(bed.type) ? bed : null;
    };
    ctx.sandAt = sandAt;
    // rock cut beyond plan for arches that had already fallen: down as talus now
    for (const o of this.orphans.splice(0)) { this._talus(ctx.edits, o.cells, o.vol, A); this.store -= o.vol; }
    for (const a of [...this.list]) this._age(a, dtKyr, ctx);
    if (this.list.length < MAX_ARCHES && dtKyr > 0) {
      if (T.struct.joints.length) this._findFins(dtKyr, ctx);
      this._findBridges(dtKyr, ctx);
    }
    await this._flush(ctx.edits, A, gen, sim);
    this._upload();
  }

  // ---- edits ----
  // a cell is cut down to an arch's floor (planned volume `plan` m, from the readback) and/or gets talus
  _cut(E, i, floor, plan, arch, cells) {
    const e = E.get(i) || { talus: 0 };
    if (e.floor === undefined || floor < e.floor) { e.floor = floor; e.plan = plan; e.arch = arch; e.cells = cells; }
    E.set(i, e);
  }
  // spread m3 of talus over cells (as soil), even shares
  _talus(E, cells, vol, A) {
    if (vol <= 0 || !cells.length) return;
    const dz = vol / (cells.length * A);
    for (const i of cells) { const e = E.get(i) || { talus: 0 }; e.talus += dz; E.set(i, e); }
  }
  // Apply the edits on the GPU, then read back what was actually cut. The ground may have changed
  // since the readback the plan came from (the frame loop keeps running), so the difference goes
  // into that arch's lintel: the solids books stay exact.
  async _flush(E, A, gen, sim) {
    if (!E.size) return;
    // cuts first, so the cap never drops a cut whose rock was already booked into a lintel
    const list = [...E].sort((p, q) => (q[1].floor !== undefined) - (p[1].floor !== undefined));
    const k = Math.min(list.length, MAX_EDITS);
    if (list.length > MAX_EDITS) console.warn(`arches: ${list.length - MAX_EDITS} edits dropped`);
    const arr = new Float32Array((k + 1) * 4);
    for (let j = 0; j < k; j++) {
      const [i, e] = list[j];
      arr.set([i, e.floor ?? 0, e.talus, e.floor !== undefined ? 1 : 0], 4 * (j + 1));
    }
    arr[0] = k;
    const d = this.device;
    d.queue.writeBuffer(this.editBuf, 0, arr);
    const enc = d.createCommandEncoder({ label: 'arches.edit' });
    const pass = enc.beginComputePass();
    pass.setPipeline(this.k.pipeline); pass.setBindGroup(0, this.bg);
    pass.dispatchWorkgroups(Math.ceil(k / 64));
    pass.end();
    const bytes = (k + 1) * 16;
    const st = d.createBuffer({ size: bytes, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST, label: 'arches.cut' });
    enc.copyBufferToBuffer(this.editBuf, 0, st, 0, bytes);
    d.queue.submit([enc.finish()]);
    try {
      await st.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(st.getMappedRange());
      if (gen !== sim.gen) return;
      for (let j = 0; j < k; j++) {
        const e = list[j][1];
        if (e.floor === undefined) continue;
        const delta = (out[4 * (j + 1) + 1] - e.plan) * A;   // m3 cut beyond (or short of) the plan
        if (!delta) continue;
        this.store += delta;
        if (this.list.includes(e.arch)) e.arch.L = Math.max(0, e.arch.L + delta);
        else if (delta > 0) this.orphans.push({ cells: e.cells, vol: delta });   // its arch already fell: released as talus next check
      }
    } finally {
      try { st.unmap(); } catch { /* not mapped */ }
      st.destroy();
    }
  }

  // ---- geometry helpers ----
  _cell(N, x, y) {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 1 || yi < 1 || xi >= N - 1 || yi >= N - 1) return -1;
    return yi * N + xi;
  }
  // cells of row j (along the span) across the arch's width
  _row(a, j, N) {
    const out = [];
    for (let k = -a.wL; k <= a.wR; k++) {
      const i = this._cell(N, a.x + j * a.tx + k * a.nx, a.y + j * a.ty + k * a.ny);
      if (i >= 0 && !out.includes(i)) out.push(i);
    }
    return out;
  }
  _abut(a, N) {
    return [this._cell(N, a.x - (a.jL + 1) * a.tx, a.y - (a.jL + 1) * a.ty), this._cell(N, a.x + (a.jR + 1) * a.tx, a.y + (a.jR + 1) * a.ty)];
  }
  // talus goes to the foot of the fin on both sides
  _flanks(a, N) {
    const out = [];
    for (let j = -a.jL - 1; j <= a.jR + 1; j++) for (const k of [-a.wL - 1, -a.wL - 2, a.wR + 1, a.wR + 2]) {
      const i = this._cell(N, a.x + j * a.tx + k * a.nx, a.y + j * a.ty + k * a.ny);
      if (i >= 0 && !out.includes(i)) out.push(i);
    }
    return out;
  }
  // lintel volume (m3) for the arch's current shape with its top at `top`
  _lintel(a, top, N, A) {
    const half = 0.5 * (a.jL + a.jR + 2);          // half the span, cells (abutment to abutment)
    const mid = 0.5 * (a.jR - a.jL);
    let v = 0;
    for (let j = -a.jL; j <= a.jR; j++) {
      const u = (j - mid) / half;
      const yin = a.floor + a.openH * Math.sqrt(Math.max(0, 1 - u * u));
      v += Math.max(0, top - yin) * this._row(a, j, N).length * A;
    }
    return v;
  }
  _near(x, y, sp) { return this.list.some((a) => Math.hypot(a.x - x, a.y - y) < sp); }

  // ---- forming ----
  _form(a, ctx) {
    const { N, A, b, s, G, edits } = ctx;
    const [iA, iB] = this._abut(a, N);
    if (iA < 0 || iB < 0) return false;
    const top = Math.min(G[iA], G[iB]);
    if (top - a.floor < a.openH + 3) return false;
    let removed = 0;
    const flanks = this._flanks(a, N);
    for (let j = -a.jL; j <= a.jR; j++) for (const i of this._row(a, j, N)) {
      if (b[i] <= a.floor) continue;
      removed += (b[i] - a.floor + s[i]) * A;
      this._cut(edits, i, a.floor, b[i] - a.floor + s[i], a, flanks);
    }
    const L = Math.min(this._lintel(a, top, N, A), removed);
    this._talus(edits, flanks, removed - L, A);
    a.L = L; a.top = top; a.age = 0;
    this.store += L;
    this.list.push(a);
    this.formed++; if (a.kind === 'bridge') this.bridgesFormed++;
    this.log.push({ day: this.lastDay, what: 'formed', kind: a.kind, x: a.x, y: a.y });
    this.onEvent?.({ type: 'formed', arch: a });
    return true;
  }

  // ---- aging ----
  _age(a, dtKyr, ctx) {
    const { N, A, b, s, G, edits } = ctx;
    a.age += dtKyr;
    let [iA, iB] = this._abut(a, N);
    if (iA < 0 || iB < 0) { this._collapse(a, ctx); return; }
    let top = Math.min(G[iA], G[iB]);
    // the opening grows: spalling at the soft contact, frost and seepage
    a.openH += ARCH_PARAMS.openRate * ARCH_SPEEDUP * a.weather * dtKyr;
    // widen one cell when the opening is tall for its span and the fin goes on
    const spanM = (a.jL + a.jR + 1) * ctx.cs;
    let removed = 0;
    if (a.openH > 0.7 * spanM && a.jL + a.jR < 8) {
      const side = (a.jL <= a.jR) ? -1 : 1;
      const j = side < 0 ? -a.jL - 1 : a.jR + 1;
      const next = side < 0 ? this._cell(N, a.x + (j - 1) * a.tx, a.y + (j - 1) * a.ty) : this._cell(N, a.x + (j + 1) * a.tx, a.y + (j + 1) * a.ty);
      if (next >= 0 && G[next] > a.floor + a.openH + 4) {
        const flanks = this._flanks(a, N);
        for (const i of this._row(a, j, N)) {
          if (b[i] <= a.floor) continue;
          removed += (b[i] - a.floor + s[i]) * A;
          this._cut(edits, i, a.floor, b[i] - a.floor + s[i], a, flanks);
        }
        if (side < 0) a.jL++; else a.jR++;
        [iA, iB] = this._abut(a, N);
        top = Math.min(G[iA], G[iB]);
        a.widened = (a.widened || 0) + 1;
      }
    }
    a.top = top;
    const span = (a.jL + a.jR + 1) * ctx.cs;
    const thick = top - a.floor - a.openH;
    if (thick < 1.0 + 0.02 * span || top < a.floor + 2) {
      // rock cut while widening this check falls with the lintel (it was in nobody's books otherwise)
      a.L += removed; this.store += removed;
      this._collapse(a, ctx); return;
    }
    // lintel: thins as the opening rises and its top wears down; the difference falls as talus
    const L = Math.min(this._lintel(a, top, N, A), a.L + removed);
    this._talus(edits, this._flanks(a, N), a.L + removed - L, A);
    this.store += L - a.L;
    a.L = L;
  }

  _collapse(a, ctx) {
    const { N, A, edits } = ctx;
    const cells = [];
    for (let j = -a.jL; j <= a.jR; j++) cells.push(...this._row(a, j, N));
    this._talus(edits, cells, a.L, A);
    this.store -= a.L;
    a.L = 0;
    this.list.splice(this.list.indexOf(a), 1);
    this.fallen++;
    this.log.push({ day: this.lastDay, what: 'fell', kind: a.kind, x: a.x, y: a.y, age: a.age });
    this.onEvent?.({ type: 'fell', arch: a });
  }

  // ---- finding fins ----
  _findFins(dtKyr, ctx) {
    const { N, b, s, G, T, sandAt } = ctx;
    const P = ARCH_PARAMS;
    const at = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return (xi < 0 || yi < 0 || xi >= N || yi >= N) ? NaN : G[yi * N + xi]; };
    let cands = 0;
    for (const J of T.struct.joints) {
      const nx = J.nx, ny = J.ny, tx = -ny, ty = nx;
      for (let y = 6; y < N - 6; y++) for (let x = 6; x < N - 6; x++) {
        const i = y * N + x;
        if (s[i] > 1.0) continue;
        const g0 = G[i];
        // width across the fin (cells within 3 m of its top), at most 3
        let wL = 0, wR = 0;
        while (wL < 3 && at(x - (wL + 1) * nx, y - (wL + 1) * ny) >= g0 - 3) wL++;
        while (wR < 3 && at(x + (wR + 1) * nx, y + (wR + 1) * ny) >= g0 - 3) wR++;
        if (wL + wR + 1 > 4) continue;
        const sideL = at(x - (wL + 1) * nx, y - (wL + 1) * ny), sideR = at(x + (wR + 1) * nx, y + (wR + 1) * ny);
        const finH = g0 - Math.max(sideL, sideR);
        if (!(finH >= P.finMinH)) continue;
        // it runs on along the joints: two cells each way still high and still a narrow wall
        let ok = true;
        for (const j of [-2, -1, 1, 2, 3]) {
          const cx = x + j * tx, cy = y + j * ty, gj = at(cx, cy);
          if (!(gj >= g0 - 4)) { ok = false; break; }
          const d = gj - Math.max(at(cx - (wL + 1) * nx, cy - (wL + 1) * ny), at(cx + (wR + 1) * nx, cy + (wR + 1) * ny));
          if (!(d >= 0.6 * P.finMinH)) { ok = false; break; }
        }
        if (!ok) continue;
        const bed = sandAt(i);
        if (!bed) continue;
        if (this._near(x, y, P.spacing)) continue;
        cands++;
        // a soft bed in the fin's lower part: the window opens at the contact
        const base = g0 - finH;
        let zSoft = null;
        for (let z = b[i] - 4; z >= base - 2; z -= 1) {
          const k = T.beds[strataLayer(z, x, y, T)];
          if (k && !k.hard) { zSoft = z; break; }
        }
        const floor = zSoft !== null ? Math.max(base, zSoft - 1) : base;
        if (g0 - floor < 12) continue;
        const width = wL + wR + 1;
        const p = P.pFin * ARCH_SPEEDUP * dtKyr * (zSoft !== null ? 1 : 0.15) * (width === 1 ? 1 : width === 2 ? 0.7 : width === 3 ? 0.4 : 0.2);
        if (this._rand() >= p) continue;
        // the window opens two cells long, so it can be seen through from the start
        const arch = { kind: 'arch', x, y, nx, ny, tx, ty, wL, wR, jL: 0, jR: 1, floor,
          openH: Math.min(10, Math.max(3, 0.25 * (g0 - floor))), weather: bed.weather, rock: bed.name, soft: zSoft !== null };
        this._form(arch, ctx);
        if (this.list.length >= MAX_ARCHES) return;
      }
    }
    this.lastCandidates = cands;
  }

  // ---- finding meander necks ----
  _findBridges(dtKyr, ctx) {
    const { N, w, G, sandAt } = ctx;
    const P = ARCH_PARAMS;
    const wet = (i) => w[i] > 0.05;
    const dirs = [[1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2], [Math.SQRT1_2, -Math.SQRT1_2]];
    let necks = 0;
    for (let y = 5; y < N - 5; y++) for (let x = 5; x < N - 5; x++) {
      const i = y * N + x;
      if (wet(i)) continue;
      for (const [dx, dy] of dirs) {
        // a wet cell within 3 cells on each side, with only dry wall between
        let iL = -1, iR = -1, kL = 0, kR = 0;
        for (let k = 1; k <= 3; k++) { const c = this._cell(N, x - k * dx, y - k * dy); if (c < 0) break; if (wet(c)) { iL = c; kL = k; break; } }
        if (iL < 0) continue;
        for (let k = 1; k <= 3; k++) { const c = this._cell(N, x + k * dx, y + k * dy); if (c < 0) break; if (wet(c)) { iR = c; kR = k; break; } }
        if (iR < 0 || kL + kR - 1 > 3) continue;
        const floor = Math.max(G[iL], G[iR]);
        if (G[i] < floor + 12) continue;
        // the wall runs on across: both abutments stand high too
        const tx = -dy, ty = dx;
        const a1 = this._cell(N, x - tx, y - ty), a2 = this._cell(N, x + tx, y + ty);
        if (a1 < 0 || a2 < 0 || G[a1] < floor + 10 || G[a2] < floor + 10 || wet(a1) || wet(a2)) continue;
        if (!sandAt(i)) continue;
        if (this._near(x, y, P.spacing)) continue;
        // the stream's way round from one side of the wall to the other is long: a meander neck
        const L = this._pathLen(iL, iR, N, w, 4 * (kL + kR) + 1);
        if (L < 0) continue;
        necks++;
        if (this._rand() >= P.pBridge * ARCH_SPEEDUP * dtKyr) continue;
        const arch = { kind: 'bridge', x, y, nx: dx, ny: dy, tx, ty, wL: kL - 1, wR: kR - 1, jL: 0, jR: 0, floor,
          openH: Math.min(10, Math.max(3, 0.35 * (G[i] - floor))), weather: sandAt(i).weather, rock: sandAt(i).name, soft: false };
        this._form(arch, ctx);
        break;
      }
    }
    this.lastNecks = necks;
  }
  // shortest path along wet cells from a to b (4-neighbour), or -1 if it is shorter than minLen
  // or longer than 600 steps
  _pathLen(a, b, N, w, minLen) {
    const dist = new Map([[a, 0]]);
    let q = [a];
    while (q.length) {
      const nq = [];
      for (const c of q) {
        const d = dist.get(c);
        if (c === b) return d >= minLen ? d : -1;
        if (d >= 600) return -1;
        const x = c % N, y = (c / N) | 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + ox, yy = y + oy;
          if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
          const j = yy * N + xx;
          if (w[j] > 0.05 && !dist.has(j)) { dist.set(j, d + 1); nq.push(j); }
        }
      }
      q = nq;
    }
    return -1;
  }

  // ---- GPU instance list (renderer) ----
  // 3 vec4 per arch: (centre gx, gy, span axis tx, ty), (floor m, opening height m, half-span cells,
  // half-width cells), (abutment A index, abutment B index, kind, across-offset cells)
  _upload() {
    if (!this.device || !this.world) return;
    const out = new Float32Array(MAX_ARCHES * 12);
    const N = this.world.N;
    this.list.slice(0, MAX_ARCHES).forEach((a, k) => {
      const mid = 0.5 * (a.jR - a.jL), off = 0.5 * (a.wR - a.wL);
      const [iA, iB] = this._abut(a, N);
      out.set([a.x + mid * a.tx + off * a.nx, a.y + mid * a.ty + off * a.ny, a.tx, a.ty,
        a.floor, a.openH, 0.5 * (a.jL + a.jR + 2), 0.5 * (a.wL + a.wR + 1),
        iA, iB, a.kind === 'bridge' ? 1 : 0, 0], 12 * k);
    });
    this.device.queue.writeBuffer(this.world.buffers.arches, 0, out);
  }
  get count() { return Math.min(this.list.length, MAX_ARCHES); }
}

export const arches = new Arches();
