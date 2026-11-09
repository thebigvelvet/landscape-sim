// Earthquakes: the map's faults (sim/strata.js S.faults) come alive on their own.
//
// Each fault slips now and then, at a rate and size set by its province (QUAKE_PROVINCES). The real
// ranking is kept (Southern Rockies rift faults busiest and biggest, Colorado Plateau and Valley and
// Ridge rare and moderate, Gulf Coast growth faults mostly creeping without shaking), but everything
// is sped up roughly 10-50x so every map shows something within a few thousand years. Maps with no
// fault still get rare small "background" quakes that loosen slopes but leave no fault cliff.
//
// What a quake does:
//  - Ground offset: the down side of the fault (the side the strata step puts lower, t > 0) drops by
//    the slip, with the same tanh profile and width as the rock step, plus a shallow sag along the
//    foot of the scarp where ponds collect. It goes through sculpt.js (OP.fault), which moves bedrock
//    and initHeight together, so the solids books stay exact and the scarp is not counted as erosion.
//    The fault's throw grows by the same slip, so the rock layers on both sides still match the
//    ground; volcanic unit bases (absolute heights) and arch floors on the down side move with it.
//  - Shaking: for one batch, slopes near the rupture stand at lower angles (soil, talus and cliffs
//    in erosion.js thermal, snow in snow.js avalanches) and a few extra slump/rockfall/avalanche
//    passes run, so landslides, rockfalls and avalanches happen at once. Slides that block a valley
//    dam a lake through the ordinary water code.
//  - Springs: rock near the fault drains faster for a few years (groundwater.js), so springs along
//    it run harder, then settle back.
// The visuals (toast, camera shake, glowing fault line) hang off onEvent / `glow` in main.js and the
// renderer.
import { sculptor } from './sculpt.js';
import { TB } from './strata.js';
import { arches } from './arches.js';

// Per province: rate = quakes of magnitude >= mMin per fault per year (sped up); mMax = the largest a
// fault there makes; bgRate = background quakes per map per year (anywhere, no surface rupture);
// creep = slow aseismic slip (m/yr) on growth faults (0.5 mm/yr: a faint step, as on the real Gulf
// Coast, where new mud keeps burying it); slipMul = extra slip per quake, so fault
// cliffs can be seen against the Rockies' kilometre of relief (the user's choice: believable, not exact).
// Rupture length (Wells & Coppersmith): ~13 km at M6, ~49 km at M7, so from about M5.5 up the whole
// trace on a 5 km map breaks; only smaller quakes break part of it.
export const QUAKE_PROVINCES = {
  rockies:     { rate: 1 / 250,  mMin: 5.0, mMax: 7.2, bgRate: 1 / 1500, bgMax: 5.8, creep: 0, slipMul: 3 },
  plateau:     { rate: 1 / 1200, mMin: 5.0, mMax: 6.8, bgRate: 1 / 3000, bgMax: 5.5, creep: 0 },
  valleyRidge: { rate: 1 / 1500, mMin: 5.0, mMax: 6.5, bgRate: 1 / 3000, bgMax: 5.5, creep: 0 },
  gulf:        { rate: 1 / 8000, mMin: 4.8, mMax: 5.8, bgRate: 1 / 8000, bgMax: 5.0, creep: 0.0005 },
};
export const QUAKE_PARAMS = {
  b: 1.0,             // Gutenberg-Richter b-value: ten times as many M5 as M6
  bgMin: 4.5,         // smallest background quake drawn
  slipMax: 3.0,       // m
  sagFrac: 0.25,      // sag pond depth at the foot of the scarp, as a share of the slip
  creepStep: 0.05,    // creep is applied once this much has built up (m)
  toastMin: 5.0,      // quakes below this pass without a notice
  springYears: 8,     // e-folding time of the post-quake spring boost
  springL: 300,       // m from the fault line the spring boost reaches
};
// plain names for the notices
const KIND_NAME = { normal: 'fault', fault: 'fault', thrust: 'thrust fault', growth: 'fault under the plain' };

// Slip (m) for magnitude M: ~0.16 m at M5, 0.5 m at M6, 1.6 m at M7 (believable, not exact).
export const slipFor = (M) => Math.min(QUAKE_PARAMS.slipMax, Math.pow(10, 0.5 * M - 3.3));
// How strongly a quake lowers the standing angle of slopes near it (0..0.35) and how far that reaches
// (m, e-folding distance from the rupture).
// Pseudo-static: ground acceleration k (in g) lowers the standing slope tan(phi) to
// (tan phi - k) / (1 + k tan phi); ~0.65 of normal for soil under strong (k ~ 0.2 g) shaking.
export const shakeAmp = (M) => Math.min(0.35, Math.max(0.05, 0.12 * (M - 4.3)));
export const shakeReach = (M) => Math.pow(10, 0.5 * M - 0.5);   // ~100 m at M5, 300 m at M6, 1 km at M7
export const ruptureHalfLength = (M) => 500 * Math.pow(10, -2.44 + 0.59 * M);   // m

class Quakes {
  constructor() {
    this.enabled = true;       // test hook (no UI control: quakes are part of nature)
    this.onEvent = null;
    this.reset(1, null, 'plateau', 10, 256);
  }

  reset(seed, strataInfo, province, cellSize, N) {
    this.T = strataInfo; this.province = province; this.cellSize = cellSize; this.N = N;
    let s = ((seed | 0) * 1597334677 + 0x5eed) >>> 0;
    this.rng = () => {
      let t = (s = (s + 0x6d2b79f5) >>> 0);
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    this.log = [];             // every quake: { day, M, kind, fault, slip, x, y }
    this.count = 0; this.biggest = 0;
    this.slipTotal = [0, 0, 0, 0];     // m of slip per fault since load (quakes + creep)
    this.creepOwed = [0, 0, 0, 0];
    this.pendingSlip = [0, 0, 0, 0];   // held back while a sculpt stroke is open
    this.spring = null;        // { nx, ny, c, A0, day }
    this.shake = null;         // this batch's shaking (consumed by the scheduler)
    this.forced = [];          // test hook: quakes to fire at the next batch
    this.glow = null;          // { ang, c, t0, M } for the renderer
    this.glowAt = -1e9; this.glowM = 0;
  }

  get faults() { return this.T?.struct?.faults || []; }
  get P() { return QUAKE_PROVINCES[this.province] || QUAKE_PROVINCES.plateau; }
  _slip(M) { return slipFor(M) * (this.P.slipMul || 1); }

  // Gutenberg-Richter magnitude between lo and hi.
  _mag(lo, hi) {
    const b = QUAKE_PARAMS.b, u = this.rng();
    return lo - Math.log10(1 - u * (1 - Math.pow(10, -b * (hi - lo)))) / b;
  }
  // Poisson count with mean lam (small lam in practice).
  _poisson(lam) {
    if (lam <= 0) return 0;
    if (lam > 30) return Math.round(lam + Math.sqrt(lam) * (this.rng() + this.rng() + this.rng() - 1.5) * 2);
    const L = Math.exp(-lam); let k = 0, p = 1;
    do { k++; p *= this.rng(); } while (p > L);
    return k - 1;
  }

  /** Test hook: fire a quake at the next batch. fault: index or -1 for a background quake. */
  force(opts = {}) { this.forced.push({ fault: opts.fault ?? 0, M: +opts.M || 6.5, x: opts.x, y: opts.y }); }

  /**
   * Draw the quakes in the next `days` and move the ground for them. Called by the scheduler at the
   * start of a batch (before the plan is built, so the new fault throws reach this batch's rock
   * table). Returns the shaking to apply after the batch, or null.
   */
  step(sim, days, dayNow) {
    this.shake = null;
    if (!this.T || !sim.world) return null;
    const years = days / 365, P = this.P, F = this.faults, Q = QUAKE_PARAMS;
    const events = [];
    if (this.enabled) {
      F.forEach((f, k) => {
        const n = this._poisson(P.rate * years);
        for (let j = 0; j < n; j++) events.push({ fault: k, M: this._mag(P.mMin, P.mMax) });
        if (P.creep > 0 && f.kind === 'growth') this.creepOwed[k] += P.creep * years;
      });
      const nb = this._poisson(P.bgRate * years);
      for (let j = 0; j < nb; j++) events.push({ fault: -1, M: this._mag(Q.bgMin, P.bgMax) });
    }
    for (const e of this.forced.splice(0)) events.push({ ...e, fault: e.fault >= 0 && e.fault < F.length ? e.fault : -1 });

    // slip owed per fault this batch (quakes + creep that has built up)
    const slip = this.pendingSlip.slice();
    this.pendingSlip = [0, 0, 0, 0];
    for (const e of events) if (e.fault >= 0) slip[e.fault] += this._slip(e.M);
    F.forEach((_, k) => { if (this.creepOwed[k] >= Q.creepStep) { slip[k] += this.creepOwed[k]; this.creepOwed[k] = 0; } });
    // a sculpt stroke snapshots initHeight around itself (undo): never move the ground inside one
    if (sculptor.stroke) { this.pendingSlip = slip; }
    else {
      let moved = false;
      F.forEach((f, k) => { if (slip[k] > 0) { this._offset(sim, f, k, slip[k]); this.slipTotal[k] += slip[k]; moved = true; } });
      if (moved) {
        arches._upload?.();
        if (sim.terrainRange) sim.terrainRange.min -= Math.max(...slip) * (1 + Q.sagFrac);
      }
    }

    if (!events.length) return null;
    // the batch shakes once, as hard as its biggest quake
    const big = events.reduce((a, e) => (e.M > a.M ? e : a));
    const N = this.N, cs = this.cellSize, ext = 0.5 * (N - 1) * cs;
    let line = null, x, y;
    if (big.fault >= 0) {
      const f = F[big.fault];
      line = { nx: f.nx, ny: f.ny, c: f.c };
      // a point on the trace inside the map, for the notice and the camera
      const t = (this.rng() - 0.5) * ext;
      x = f.nx * f.c - f.ny * t; y = f.ny * f.c + f.nx * t;
    } else {
      x = Number.isFinite(big.x) ? (big.x - 0.5 * (N - 1)) * cs : (this.rng() - 0.5) * 1.6 * ext;
      y = Number.isFinite(big.y) ? (big.y - 0.5 * (N - 1)) * cs : (this.rng() - 0.5) * 1.6 * ext;
    }
    this.shake = { M: big.M, line, x, y, A: shakeAmp(big.M), L: shakeReach(big.M), HL: ruptureHalfLength(big.M), S: this.rng(),
      passes: Math.max(2, Math.min(8, Math.round(2 + 2 * (big.M - 4.5)))) };
    if (line) this.spring = { ...line, A0: Math.min(10, Math.max(0, 4 * (big.M - 4.5))), day: dayNow + days };
    for (const e of events) {
      this.count++; this.biggest = Math.max(this.biggest, e.M);
      this.log.push({ day: dayNow + days, M: e.M, fault: e.fault, kind: e.fault >= 0 ? F[e.fault].kind : 'background', slip: e.fault >= 0 ? this._slip(e.M) : 0 });
    }
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    const kind = big.fault >= 0 ? F[big.fault].kind : 'background';
    // the slipped fault glows; at top speed a new quake does not take the glow over unless the
    // last one has faded or it is clearly bigger
    // (a quiet gap of 12 s after each glow starts, so at top speed the faults are not always lit)
    const tNow = performance.now(), lastM = this.glowM ?? 0;
    if (line && big.M >= Q.toastMin && (tNow - (this.glowAt ?? -1e9) > 12000 || big.M >= lastM + 0.7)) {
      this.glow = { ang: Math.atan2(line.ny, line.nx), c: line.c, t0: tNow, M: big.M };
      this.glowAt = tNow; this.glowM = big.M;
    }
    try {
      this.onEvent?.({ M: big.M, kind, name: KIND_NAME[kind] || 'fault', fault: big.fault, n: events.length,
        slip: big.fault >= 0 ? this._slip(big.M) : 0, x, y, day: dayNow + days, toast: big.M >= Q.toastMin });
    } catch (e) { console.error(e); }
    return this.shake;
  }

  // Drop the down side of fault f by s metres (ground, initHeight, volcanic bases, arch floors) and
  // grow its throw so the rock layers keep matching.
  _offset(sim, f, k, s) {
    sculptor.fault({ nx: f.nx, ny: f.ny, c: f.c, w: f.w, slip: s, sag: QUAKE_PARAMS.sagFrac * s, cellSize: this.cellSize, years: (sim.day || 0) / 365 });
    f.throw += s;
    // only this fault's row of the packed rock table changes (sim params and renderer read it each frame)
    if (sim.strataPack) sim.strataPack.table[(TB.faults + k) * 4 + 3] = f.throw;
    const N = this.N, cs = this.cellSize;
    for (const a of arches.list) {
      const px = (a.x - 0.5 * (N - 1)) * cs, py = (a.y - 0.5 * (N - 1)) * cs;
      const t = Math.max(-10, Math.min(10, (f.nx * px + f.ny * py - f.c) / f.w));
      a.floor -= s * 0.5 * (1 + Math.tanh(t));
    }
  }

  // Uniforms for this batch: the spring boost (always) and no shaking (the scheduler turns shaking on
  // only for its extra passes).
  plan(dayNow) {
    const sp = this.spring, Q = QUAKE_PARAMS;
    let gqA = 0;
    if (sp) {
      gqA = sp.A0 * Math.exp(-Math.max(0, dayNow - sp.day) / (365 * Q.springYears));
      if (gqA < 0.02) { this.spring = null; gqA = 0; }
    }
    return { fields: {
      qA: 0, qMode: 0, qNx: 0, qNy: 0, qC: 0, qX: 0, qY: 0, qL: 1, qHL: 0, qS: 0,
      gqA, gqNx: sp?.nx ?? 0, gqNy: sp?.ny ?? 0, gqC: sp?.c ?? 0, gqL: Q.springL,
    } };
  }

  // Uniforms for the shaking passes.
  shakeFields(q) {
    return {
      qA: q.A, qMode: q.line ? 1 : 2, qNx: q.line?.nx ?? 0, qNy: q.line?.ny ?? 0, qC: q.line?.c ?? 0,
      qX: q.x, qY: q.y, qL: q.L, qHL: q.HL, qS: q.S,
    };
  }
}

export { QUAKE_WGSL } from './common.js';

export const quakes = new Quakes();
export default quakes;
