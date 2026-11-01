// Event brush tool: picks the point on the 3D terrain under the mouse (ray march against the height
// field), draws the cursor ring and applies Storm / Drought / Flood / Wildfire on click or drag.
//
// Picking runs on the CPU against a cached copy of the displayed surface (bedrock + soil + snow),
// refreshed from the GPU every few seconds while a tool is selected. The ray comes from the same
// view-projection matrix the renderer used for the last frame (including its lens shift), so the
// ring and the brush land exactly under the cursor.

export const TOOLS = ['off', 'storm', 'drought', 'flood', 'wildfire'];

function mulVec(m, v) {
  const o = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) o[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3];
  return o;
}

export class BrushTool {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.tool = 'off';
    this.radiusM = 400;          // metres
    this.intensity = 1;
    this.slowDown = true;
    this.heights = null;         // Float32Array N*N of displayed surface height (m above datum)
    this.heightsN = 0;
    this.refreshing = false;
    this.lastRefresh = 0;
    this.painting = false;
    this.lastApply = null;
    this.onApplied = null;       // callback(info) for the panel
    this.bind();
  }

  get active() { return this.tool !== 'off'; }

  setTool(t) {
    this.tool = TOOLS.includes(t) ? t : 'off';
    const r = this.app.renderer;
    r.brush.tool = TOOLS.indexOf(this.tool);
    r.brush.visible = false;
    this.canvas.style.cursor = this.active ? 'crosshair' : '';
    if (this.active) this.refresh(true);
  }

  radiusCells() { return this.radiusM / (this.app.sim.cellSize || 10); }

  async refresh(force = false) {
    const sim = this.app.sim;
    if (!sim.world || this.refreshing) return;
    const now = performance.now();
    if (!force && now - this.lastRefresh < 3000) return;
    this.refreshing = true;
    try {
      const [b, s, w] = await Promise.all([sim.readLayer('bedrock'), sim.readLayer('soil'), sim.readLayer('snowSWE')]);
      const h = new Float32Array(b.length);
      for (let i = 0; i < h.length; i++) h[i] = b[i] + s[i] + w[i] / 0.33;
      this.heights = h;
      this.heightsN = sim.world.N;
      this.lastRefresh = performance.now();
    } catch (e) { console.warn('brush height refresh failed', e); } finally { this.refreshing = false; }
  }

  // Height of the displayed surface at fractional grid coordinates (bilinear), metres x exaggeration.
  surf(gx, gy) {
    const N = this.heightsN, H = this.heights;
    const x = Math.max(0, Math.min(N - 1.001, gx)), y = Math.max(0, Math.min(N - 1.001, gy));
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const i = y0 * N + x0;
    const a = H[i], b = H[i + 1], c = H[i + N], d = H[i + N + 1];
    return ((a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty) * this.app.renderer.vex;
  }

  /** Grid cell (fractional x, y) under the given client position, or null if the ray misses. */
  pick(clientX, clientY) {
    const r = this.app.renderer, sim = this.app.sim;
    const m = r.lastMatrices;
    if (!m || !sim.world) return null;
    const rect = this.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const a = mulVec(m.invViewProj, [nx, ny, 0, 1]);
    const b = mulVec(m.invViewProj, [nx, ny, 1, 1]);
    const o = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
    const f = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
    let d = [f[0] - o[0], f[1] - o[1], f[2] - o[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    d = d.map((v) => v / len);
    const N = sim.world.N, dx = sim.cellSize, c = (N - 1) * 0.5;
    const toGrid = (p) => [p[0] / dx + c, p[2] / dx + c];
    if (!this.heights || this.heightsN !== N) {
      // no height cache yet: intersect the mid-height plane
      const tr = sim.terrainRange || { min: 0, max: 0 };
      const yP = (tr.min + tr.max) * 0.5 * r.vex;
      if (Math.abs(d[1]) < 1e-6) return null;
      const t = (yP - o[1]) / d[1];
      if (t <= 0) return null;
      const g = toGrid([o[0] + d[0] * t, 0, o[2] + d[2] * t]);
      return g[0] >= 0 && g[1] >= 0 && g[0] <= N - 1 && g[1] <= N - 1 ? { x: g[0], y: g[1] } : null;
    }
    // clip the ray to the map's box in x/z
    const half = c * dx;
    let t0 = 0, t1 = len;
    for (const k of [0, 2]) {
      if (Math.abs(d[k]) < 1e-9) { if (o[k] < -half || o[k] > half) return null; continue; }
      let ta = (-half - o[k]) / d[k], tb = (half - o[k]) / d[k];
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    }
    if (t0 >= t1) return null;
    const step = dx * 0.5;
    let prevT = t0, prevAbove = true;
    for (let t = t0; t <= t1; t += step) {
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      const g = toGrid(p);
      const above = p[1] > this.surf(g[0], g[1]);
      if (!above && prevAbove && t > t0) {
        // bisection between prevT and t
        let lo = prevT, hi = t;
        for (let k = 0; k < 20; k++) {
          const mid = 0.5 * (lo + hi);
          const q = [o[0] + d[0] * mid, o[1] + d[1] * mid, o[2] + d[2] * mid];
          const gq = toGrid(q);
          if (q[1] > this.surf(gq[0], gq[1])) lo = mid; else hi = mid;
        }
        const gh = toGrid([o[0] + d[0] * hi, 0, o[2] + d[2] * hi]);
        return { x: gh[0], y: gh[1] };
      }
      if (!above && t === t0) {
        const gg = toGrid(p);
        return { x: gg[0], y: gg[1] };
      }
      prevAbove = above; prevT = t;
    }
    return null;
  }

  async apply(p) {
    const app = this.app, sim = app.sim;
    const info = await sim.brush(this.tool, { x: p.x, y: p.y, radius: this.radiusCells(), intensity: this.intensity });
    if (this.slowDown) {
      const s = sim.speed;
      if ((this.tool === 'storm' || this.tool === 'flood') && s > 2) app.setSpeed(1);
      else if (this.tool === 'drought' && (s > 3 * 365 || s < 30)) app.setSpeed(365);
      else if (this.tool === 'wildfire' && s > 3650) app.setSpeed(365);
      if (sim.paused) app.play();
    }
    this.onApplied?.(info);
    return info;
  }

  bind() {
    const c = this.canvas;
    const cam = this.app.renderer.camera;
    // the orbit camera ignores the left button while a tool is selected (right-drag still pans)
    cam.leftButtonBlocked = () => this.active;
    c.addEventListener('pointerdown', (e) => {
      if (!this.active || e.button !== 0 || e.shiftKey) return;
      const p = this.pick(e.clientX, e.clientY);
      if (!p) return;
      this.painting = true;
      this.lastApply = p;
      this.apply(p);
    });
    c.addEventListener('pointermove', (e) => {
      if (!this.active) return;
      this.refresh();
      const p = this.pick(e.clientX, e.clientY);
      const b = this.app.renderer.brush;
      b.visible = !!p;
      if (p) { b.x = p.x; b.y = p.y; b.radius = this.radiusCells(); }
      if (this.painting && p && (e.buttons & 1)) {
        const dd = Math.hypot(p.x - this.lastApply.x, p.y - this.lastApply.y);
        // dragging: one application per ~70 % of the radius moved (a stroke paints a band)
        if (dd >= Math.max(1, 0.7 * this.radiusCells()) && this.tool !== 'flood') { this.lastApply = p; this.apply(p); }
      }
    });
    const stop = () => { this.painting = false; };
    c.addEventListener('pointerup', stop);
    c.addEventListener('pointerleave', () => { stop(); this.app.renderer.brush.visible = false; });
  }
}
