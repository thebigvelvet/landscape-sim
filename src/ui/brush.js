// Weather brushes and sculpt brushes: the tool rows, ray picking against the height field, the
// cursor ring, click and drag painting, and the "what just happened" message.
//
// Picking runs on the CPU against a cached copy of the ground height (bedrock + soil), refreshed
// from the GPU about once a second while a tool is selected (heights change slowly). The ray comes
// from the renderer's own inverse view-projection, so it matches what is on screen exactly,
// including the lens shift that keeps the land clear of the side panel.
import { TOOL_IDS } from '../render/renderer.js';
import { ERUPTION_STYLES } from '../sim/volcano.js';

const $ = (id) => document.getElementById(id);

export const TOOLS = [
  { id: 'none', name: 'Look around', key: '1', tip: 'Drag to turn the view, right-drag to slide, scroll to zoom. Clicking the land does nothing.',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 3c-1 0-1.6.8-1.6 1.7v7.1l-1.6-1.6c-.7-.7-1.7-.7-2.3 0-.6.6-.6 1.6 0 2.2l4.6 5.4c1 1.2 2.4 2.2 4.2 2.2h.7c2.8 0 4.6-2.1 4.6-4.9V9.6c0-.9-.7-1.6-1.6-1.6s-1.5.7-1.5 1.6v-1c0-.9-.7-1.6-1.6-1.6s-1.6.7-1.6 1.6v-.5c0-.9-.7-1.6-1.6-1.6V4.7C13.6 3.8 13 3 12 3z"/></svg>' },
  { id: 'storm', name: 'Storm', key: '2', tip: 'Click to drop a cloudburst on that spot: three days of very heavy rain (or snow when it is cold), up to 240 mm in the middle. Drag to steer the storm.',
    icon: '<svg viewBox="0 0 24 24"><path d="M7 15a5 5 0 0 1-.6-10 6 6 0 0 1 11.3 1.6A4.2 4.2 0 0 1 17 15z"/><path d="M8 17l-1.5 4M12 17l-1.5 4M16 17l-1.5 4" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M12.5 14.5l-2 3.5h2.6l-1.6 3.5" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>' },
  { id: 'drought', name: 'Drought', key: '3', tip: 'Click anywhere to start a five-year drought over the whole map: little rain or snow and hotter air. Grass turns gold then brown, groundwater falls, and dry forests burn easily.',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="4.2"/><path d="M12 1.5v2.6M12 16v2.2M3.5 10h2.6M18 10h2.5M6 4l1.8 1.8M16.2 14.2l1.8 1.8M6 16l1.8-1.8M16.2 5.8L18 4" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M3 21.5l3-2 2.5 1.5 3-2.5 2.5 2 3-1.5 3 2.5" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>' },
  { id: 'flood', name: 'Flood', key: '4', tip: 'Click a valley or stream to send a 100-year flood down it: a 12-hour flood wave (peak 150 cubic metres per second) pours in at that spot from upstream. Best watched in slow motion (1 hour per second).',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 9c2 0 2-1.6 4-1.6S8 9 10 9s2-1.6 4-1.6S16 9 18 9s2-1.6 4-1.6M2 14c2 0 2-1.6 4-1.6S8 14 10 14s2-1.6 4-1.6 2 1.6 4 1.6 2-1.6 4-1.6M2 19c2 0 2-1.6 4-1.6S8 19 10 19s2-1.6 4-1.6 2 1.6 4 1.6 2-1.6 4-1.6" stroke-width="2" stroke-linecap="round" fill="none"/></svg>' },
  { id: 'wildfire', name: 'Wildfire', key: '5', tip: 'Click or drag to set the plants on fire. Dry plants nearby can catch, and fire runs uphill and with the wind. Burned slopes shed water and mud in the next storms until plants grow back.',
    icon: '<svg viewBox="0 0 24 24"><path d="M12.3 2.2c.4 3-1.5 4.6-3 6.3-1.6 1.8-3 3.6-3 6.4A5.8 5.8 0 0 0 12 21a5.8 5.8 0 0 0 5.8-5.9c0-2.5-1.2-4.6-2.7-6.3-.3 1.4-1 2.6-2.2 3.2.6-3.2-.1-6.6-.6-9.8z"/><path d="M12 20.5c-1.6 0-2.8-1.2-2.8-2.8 0-1.6 1.3-2.6 2.2-3.8.2 1 .8 1.6 1.6 1.9.4-.6.5-1.2.6-1.8.9 1 1.2 2.2 1.2 3.4 0 1.7-1.2 3.1-2.8 3.1z" fill="#ffd27a"/></svg>' },
  { id: 'volcano', name: 'Volcano', key: '6', tip: 'Pick an eruption style, then click to open a volcano there: cinder cones, lava flows, lava domes, ash falls, pyroclastic flows or steam-blast craters, burning plants and melting snow and ice in their way. The strength slider makes it bigger or smaller.',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 21l6.5-11h2.2l1.3 2 1.3-2h2.2L22 21z" stroke="none"/><path d="M10 7c-.6-1.6.3-3.2 2-3.4M14 7c.8-1.2.3-2.8-1-3.6M12 6.5V2" stroke-width="1.6" stroke-linecap="round" fill="none"/><path d="M12 12.5c-.6 2-1.8 3-1.4 5 .3 1.2 1 1.9 1.4 3.5.4-1.6 1.1-2.3 1.4-3.5.4-2-.8-3-1.4-5z" fill="#ff7a2a"/></svg>' },
];

// Shaping the land (sim/sculpt.js). Hold and drag; they share the size and strength sliders.
export const SCULPT_TOOLS = [
  { id: 'raise', name: 'Raise', key: 'q', kind: 'sculpt', tip: 'Hold and drag to push the ground up into hills, ridges or a dam. Water will pool behind it and find its way around.',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 20c4 0 5-9 10-9s6 9 10 9z" stroke="none"/><path d="M12 9V2M8.5 5.2L12 1.8l3.5 3.4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' },
  { id: 'lower', name: 'Lower', key: 'w', kind: 'sculpt', tip: 'Hold and drag to dig the ground down: a basin fills into a lake, a dip catches the streams.',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 13c4 0 5 7 10 7s6-7 10-7v8H2z" stroke="none"/><path d="M12 2v8M8.5 6.6L12 10l3.5-3.4" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>' },
  { id: 'smooth', name: 'Smooth', key: 'e', kind: 'sculpt', tip: 'Hold and drag to soften sharp peaks, cliffs and pits, like ages of weathering in a few seconds.',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 17c3.5 0 4-6 7-6s4 4 7 4 3.5-3 6-3v9H2z" stroke="none"/><path d="M3 7c3-3 5 0 8-2s5-2 9-.5" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>' },
  { id: 'flatten', name: 'Flatten', key: 'r', kind: 'sculpt', tip: 'Press on the land to pick that height, then drag to level the ground to it: mesas, terraces, a flat valley floor.',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 21v-9h20v9z" stroke="none"/><path d="M2 8h20" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 2.4" fill="none"/></svg>' },
  { id: 'channel', name: 'Channel', key: 't', kind: 'sculpt', tip: 'Drag a line to cut a riverbed or ditch into the ground. Drag it downhill and the water will follow it.',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 9h7l3 8 3-8h7v12H2z" stroke="none"/></svg>' },
];
const ALL_TOOLS = [...TOOLS, ...SCULPT_TOOLS];
const isSculpt = (id) => SCULPT_TOOLS.some((t) => t.id === id);
const DAB_MS = 30;

// notice icons for things that are not tools
const TOAST_ICONS = {
  quake: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13h4l2-6 3 11 3-14 2 9 2-3h4" style="fill:none"/></svg>',
  timelapse: '<svg viewBox="0 0 24 24" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12M6 21h12M7 3c0 5 10 5 10 9s-10 4-10 9M17 3c0 5-10 5-10 9s10 4 10 9" style="fill:none"/></svg>',
};

export class BrushTool {
  constructor(app) {
    this.app = app;
    this.tool = 'none';
    this.radius = 15;
    this.intensity = 1;
    this.volcanoStyle = 'strombolian';
    this.H = null; this.V = null; this.hN = 0; this.hTime = 0; this.hPending = false;
    this.down = null;
    this.buildRow();
    this.bind();
  }

  get renderer() { return this.app.renderer; }
  get sim() { return this.app.sim; }

  buildRow() {
    const rows = [[TOOLS, 'tools', 'tool-help'], [SCULPT_TOOLS, 'sculpt-tools', 'sculpt-help']];
    for (const [list, rowId, helpId] of rows) {
      const row = $(rowId);
      if (!row) continue;
      row.innerHTML = '';
      for (const t of list) {
        const b = document.createElement('button');
        b.className = 'tool' + (t.id === 'none' ? ' active' : '');
        b.dataset.tool = t.id;
        b.innerHTML = `${t.icon}<span>${t.name}</span>`;
        b.title = `${t.name} (key ${t.key.toUpperCase()})`;
        b.addEventListener('click', () => this.setTool(t.id));
        b.addEventListener('mouseenter', () => { $(helpId).textContent = t.tip; });
        b.addEventListener('mouseleave', () => this.showHelp());
        row.appendChild(b);
      }
    }
    this.showHelp();
    $('undo')?.addEventListener('click', () => { this.undo(); });
    const rad = () => {
      this.radius = +$('brush-size').value;
      const m = this.radius * (this.sim.world?.cellSize || 10);
      $('brush-size-out').textContent = m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
      this.renderer.cursor.r = this.radius;
    };
    $('brush-size').addEventListener('input', rad); rad();
    const str = () => {
      this.intensity = Math.pow(2, +$('brush-strength').value);
      $('brush-strength-out').textContent = Math.abs(this.intensity - 1) < 0.05 ? 'normal' : `${this.intensity.toFixed(1)}x`;
    };
    $('brush-strength').addEventListener('input', str); str();
    const vs = $('volcano-style');
    if (vs) {
      try { const k = localStorage.getItem('volcanoStyle'); if (ERUPTION_STYLES[k]) vs.value = k; } catch { /* no storage */ }
      const pick = () => {
        this.volcanoStyle = ERUPTION_STYLES[vs.value] ? vs.value : 'strombolian';
        try { localStorage.setItem('volcanoStyle', this.volcanoStyle); } catch { /* no storage */ }
        this.showHelp();
      };
      vs.addEventListener('change', pick); pick();
    }
  }

  // help lines: the selected tool's tip in its own row; the sculpt row says how to start
  showHelp() {
    const sc = isSculpt(this.tool);
    $('tool-help').textContent = this.tool === 'volcano'
      ? `${ERUPTION_STYLES[this.volcanoStyle].name}: ${ERUPTION_STYLES[this.volcanoStyle].tip} Click the land to erupt; the strength slider makes it bigger or smaller.`
      : sc ? 'A shaping tool is picked (below). The brush size and strength sliders set how wide and how hard it digs or builds.'
      : TOOLS.find((t) => t.id === this.tool).tip;
    // Drought covers the whole map and a volcano sizes itself: the size slider does nothing for them
    $('brush-size-row')?.classList.toggle('unused', this.tool === 'drought' || this.tool === 'volcano');
    const vr = $('volcano-style-row');
    if (vr) vr.hidden = this.tool !== 'volcano';
    const sh = $('sculpt-help');
    if (sh) sh.textContent = sc ? SCULPT_TOOLS.find((t) => t.id === this.tool).tip : 'Pick a tool (keys Q W E R T), then hold and drag on the land. Ctrl+Z undoes the last stroke.';
  }

  setTool(id) {
    if (id === 'fire') id = 'wildfire';
    if (!ALL_TOOLS.some((t) => t.id === id)) id = 'none';
    this.endDrag();
    this.tool = id;
    for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === id);
    this.showHelp();
    document.body.classList.toggle('painting', id !== 'none');
    if (id === 'none') this.renderer.setCursor(false);
    else this.refreshHeights(true).catch(() => {});
  }

  // ---- height field cache for picking ----
  async refreshHeights(force = false) {
    const sim = this.sim;
    if (!sim.world || sim.loading) return;
    if (this.hPending) { if (force) this.hAgain = true; return this.hPending; }
    const now = performance.now();
    const every = isSculpt(this.tool) ? 150 : 1200;   // sculpting changes the ground fast
    if (!force && now - this.hTime < every && this.hN === sim.world.N && this.hGen === sim.gen) return;
    const N = sim.world.N, gen = sim.gen;
    this.hPending = (async () => {
      try {
        const [b, s, v] = await Promise.all([sim.readLayer('bedrock'), sim.readLayer('soil'), sim.readLayer('veg')]);
        // a new map arrived meanwhile: these heights belong to the old one
        if (gen !== sim.gen || N !== sim.world?.N || b.length !== N * N) { this.hAgain = true; return; }
        for (let i = 0; i < b.length; i++) b[i] += s[i];
        this.H = b; this.V = v; this.hN = N; this.hGen = gen; this.hTime = performance.now();
      } catch (e) { console.warn('heights', e); }
    })();
    try { await this.hPending; } finally { this.hPending = null; }
    if (this.hAgain) { this.hAgain = false; return this.refreshHeights(true); }
  }

  get heightsReady() { return !!this.H && this.hN === this.sim.world?.N && this.hGen === this.sim.gen; }

  heightAt(gx, gy, H = this.H) {
    const N = this.hN;
    const x = Math.min(Math.max(gx, 0), N - 1.001), y = Math.min(Math.max(gy, 0), N - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const i = y0 * N + x0;
    return (H[i] * (1 - tx) + H[i + 1] * tx) * (1 - ty) + (H[i + N] * (1 - tx) + H[i + N + 1] * tx) * ty;
  }

  /** Screen point (client px) -> grid cell {x, y} on the terrain, or null if the ray misses. */
  pick(clientX, clientY) {
    const r = this.renderer, sim = this.sim;
    if (!this.heightsReady || !r.lastInvViewProj) return null;
    const rect = r.canvas.getBoundingClientRect();
    const nx = ((clientX - rect.left) / rect.width) * 2 - 1;
    const ny = 1 - ((clientY - rect.top) / rect.height) * 2;
    const m = r.lastInvViewProj;
    const un = (z) => {
      const v = [m[0] * nx + m[4] * ny + m[8] * z + m[12], m[1] * nx + m[5] * ny + m[9] * z + m[13], m[2] * nx + m[6] * ny + m[10] * z + m[14], m[3] * nx + m[7] * ny + m[11] * z + m[15]];
      return [v[0] / v[3], v[1] / v[3], v[2] / v[3]];
    };
    const o = un(0), f = un(1);
    let d = [f[0] - o[0], f[1] - o[1], f[2] - o[2]];
    const L = Math.hypot(...d); d = d.map((q) => q / L);
    const N = this.hN, dx = sim.world.cellSize, c = (N - 1) * 0.5, vex = r.vex;
    const tr = sim.terrainRange;
    // clip the ray to the terrain's bounding box
    const lo = [-c * dx, (tr.min - 50) * vex, -c * dx], hi = [c * dx, (tr.max + 50) * vex, c * dx];
    let t0 = 0, t1 = L;
    for (let k = 0; k < 3; k++) {
      if (Math.abs(d[k]) < 1e-12) { if (o[k] < lo[k] || o[k] > hi[k]) return null; continue; }
      let a = (lo[k] - o[k]) / d[k], b = (hi[k] - o[k]) / d[k];
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    }
    if (t0 > t1) return null;
    const below = (t) => {
      const p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
      return p[1] <= this.heightAt(p[0] / dx + c, p[2] / dx + c) * vex;
    };
    const step = dx * 0.4;
    let prev = t0;
    if (below(t0)) return this.gridAt(o, d, t0, dx, c);
    for (let t = t0 + step; t <= t1 + step; t += step) {
      const tt = Math.min(t, t1);
      if (below(tt)) {
        let a = prev, b = tt;
        for (let k = 0; k < 14; k++) { const mid = 0.5 * (a + b); if (below(mid)) b = mid; else a = mid; }
        return this.gridAt(o, d, b, dx, c);
      }
      prev = tt;
      if (tt >= t1) break;
    }
    return null;
  }
  gridAt(o, d, t, dx, c) {
    return { x: (o[0] + d[0] * t) / dx + c, y: (o[2] + d[2] * t) / dx + c };
  }

  /** Grid cell -> client px (for tests and hints). */
  screenOf(x, y) {
    const r = this.renderer;
    const [wx, wz] = r.gridToWorld(x, y);
    const h = (this.H ? this.heightAt(x, y) : 0) * r.vex;
    const m = r.lastViewProj;
    const cx = m[0] * wx + m[4] * h + m[8] * wz + m[12], cy = m[1] * wx + m[5] * h + m[9] * wz + m[13], cw = m[3] * wx + m[7] * h + m[11] * wz + m[15];
    const rect = r.canvas.getBoundingClientRect();
    return { x: rect.left + (cx / cw * 0.5 + 0.5) * rect.width, y: rect.top + (0.5 - cy / cw * 0.5) * rect.height };
  }

  bind() {
    const cv = this.renderer.canvas;
    this.renderer.camera.blockLeft = (e) => this.tool !== 'none' && e.button === 0 && !e.shiftKey;
    cv.addEventListener('pointermove', (e) => {
      if (this.tool === 'none') return;
      this.refreshHeights().catch(() => {});
      const p = this.pick(e.clientX, e.clientY);
      const ring = this.tool === 'drought' || this.tool === 'volcano' ? 3 : this.radius;
      this.renderer.setCursor(!!p, p?.x, p?.y, ring, TOOL_IDS[this.tool]);
      if (p && this.down) { if (this.down.sculpt) this.down.p = p; else this.dragTo(p); }
    });
    cv.addEventListener('pointerleave', () => this.renderer.setCursor(false));
    cv.addEventListener('pointerdown', (e) => {
      if (this.tool === 'none' || e.button !== 0 || e.shiftKey) return;
      if (!this.heightsReady || (isSculpt(this.tool) && this.sim.sculptBusy)) {
        this.toast('miss', 'Getting ready...', 'Reading the shape of the land. Try again in a moment.');
        this.refreshHeights(true).catch(() => {});
        return;
      }
      const p = this.pick(e.clientX, e.clientY);
      if (!p) { this.toast('miss', 'Click on the land', 'That click missed the map. Point at the ground and try again.'); return; }
      cv.setPointerCapture(e.pointerId);
      if (isSculpt(this.tool)) { this.startSculpt(p); return; }
      const ev = this.apply(this.tool, p.x, p.y);
      this.down = { id: ev?.id, last: performance.now(), x: p.x, y: p.y };
    });
    const up = (e) => { this.endDrag(); cv.releasePointerCapture?.(e.pointerId); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    window.addEventListener('keydown', (e) => {
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable || (a.tagName === 'INPUT' && ['text', 'number', 'search'].includes(a.type)))) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); this.undo(); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Escape') this.setTool('none');
      const t = ALL_TOOLS.find((q) => q.key === e.key.toLowerCase());
      if (t) this.setTool(t.id);
    });
  }

  dragTo(p) {
    const now = performance.now();
    if (this.tool === 'storm' && this.down.id) {
      this.sim.events.moveStorm(this.down.id, p.x, p.y);
    } else if (this.tool === 'wildfire' && now - this.down.last > 90 && Math.hypot(p.x - this.down.x, p.y - this.down.y) > this.radius * 0.4) {
      this.sim.brush('wildfire', { x: p.x, y: p.y, radius: this.radius, intensity: this.intensity, quiet: true });
      this.sim.events.log.pop();                 // a drag is one event for the markers
      this.down.last = now; this.down.x = p.x; this.down.y = p.y;
    }
  }

  // ---- sculpting: a held stroke dabs every DAB_MS at the pointer ----
  startSculpt(p) {
    const sim = this.sim;
    if (!this.heightsReady || sim.sculptBusy) return;
    sim.beginStroke();
    const d = this.down = { sculpt: true, tool: this.tool, p, last: p, H0: this.H.slice() };
    if (this.tool === 'flatten') d.target = this.heightAt(p.x, p.y);
    this.sculptDab();
    d.timer = setInterval(() => this.sculptDab(), DAB_MS);
    this.sculptHint(this.tool);
  }

  sculptDab() {
    const d = this.down;
    if (!d?.sculpt) return;
    const p = d.p, o = { x: p.x, y: p.y, radius: this.radius, intensity: this.intensity, ground: this.heightAt(p.x, p.y) };
    if (d.tool === 'flatten') o.target = d.target;
    if (d.tool === 'channel') {
      // the bed follows the ground as it was when the stroke began, so going over a spot twice is
      // harmless; it only cuts when the pointer has moved (or on the first press)
      if (d.started && Math.hypot(p.x - d.last.x, p.y - d.last.y) < Math.max(0.75, this.radius * 0.15)) return;
      Object.assign(o, { ax: d.last.x, ay: d.last.y, za: this.heightAt(d.last.x, d.last.y, d.H0), zb: this.heightAt(p.x, p.y, d.H0) });
      d.last = p; d.started = true;
    }
    this.sim.sculpt(d.tool, o);
  }

  endDrag() {
    const d = this.down;
    this.down = null;
    if (!d?.sculpt) return;
    clearInterval(d.timer);
    this.sim.endStroke().then(() => { this.updateUndo(); return this.refreshHeights(true); }).catch((e) => console.warn(e));
    this.updateUndo(true);
  }

  async undo() {
    if (this.down?.sculpt || !this.sim.canUndo) return false;
    let box = false;
    try { box = await this.sim.undoSculpt(); } catch (e) { console.warn(e); }
    this.updateUndo();
    this.refreshHeights(true).catch(() => {});
    if (box) this.toast('undo', 'Undone', 'The last shaping stroke is gone. Any erosion since then is kept.');
    return box;
  }

  updateUndo(force) {
    const b = $('undo');
    if (b) b.disabled = !(force || this.sim.canUndo);
  }

  // the first stroke with each tool explains what it does
  sculptHint(tool) {
    if (this.hinted?.[tool]) return;
    (this.hinted ||= {})[tool] = true;
    const t = SCULPT_TOOLS.find((q) => q.id === tool);
    this.toast(tool, t.name, t.tip + ' Ctrl+Z undoes a stroke.');
  }

  /** Same as clicking: start the event, show the ripple and the message. */
  apply(type, x, y, opts = {}) {
    if (type === 'fire') type = 'wildfire';
    const o = { x, y, radius: opts.radius ?? this.radius, intensity: opts.intensity ?? this.intensity, days: opts.days };
    if (type === 'drought') delete o.radius;
    if (type === 'volcano') { delete o.radius; o.style = opts.style ?? this.volcanoStyle; if (this.heightsReady) o.ground = this.heightAt(x, y); }
    const ev = this.sim.brush(type, o);
    this.renderer.clickRipple(ev.x, ev.y, type === 'drought' ? this.sim.world.N * 0.35 : ev.r, TOOL_IDS[type]);
    this.explain(ev);
    return ev;
  }

  fuelAround(x, y, r) {
    if (!this.V || this.hN !== this.sim.world.N) return null;
    const N = this.hN; let s = 0, n = 0;
    for (let j = Math.max(0, Math.floor(y - r)); j <= Math.min(N - 1, Math.ceil(y + r)); j++) {
      for (let i = Math.max(0, Math.floor(x - r)); i <= Math.min(N - 1, Math.ceil(x + r)); i++) {
        if ((i - x) ** 2 + (j - y) ** 2 <= r * r) { s += this.V[j * N + i]; n++; }
      }
    }
    return n ? s / n : null;
  }

  // ---- "what just happened" ----
  explain(ev) {
    const sim = this.sim, speed = sim.speed, c = sim.climate;
    const fast = speed > 36 && !sim.paused;
    const doy = sim.lastClimate?.dayOfYear ?? 0;
    const zMid = sim.datum + (sim.terrainRange?.mean ?? 0);
    const cold = c.airTempAt(doy, zMid) < 0.5;
    const normal = Math.max(0.1, c.precipAt(doy) / Math.max(0.05, c.preset.wetFrac || 0.3));
    const goWord = this.app.tl ? 'Resume' : 'Start';
    const pausedNote = sim.paused ? ` Press ${goWord} to let it happen.` : '';
    const fmt = (v) => v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v < 10 ? 1 : 0);
    if (ev.type === 'storm') {
      const mm = ev.centreMm;
      const what = cold ? 'snow (as water)' : 'rain';
      let t = `Up to ${fmt(mm)} mm of ${what} will fall in the middle over ${fmt(ev.days)} days, about ${Math.round((mm / ev.days) / normal)} times a normal wet day here. Watch the gullies run and the streams turn muddy.`;
      if (fast) t += ' At this speed the storm is over in a blink, but every drop and every grain of mud it moves is counted.';
      this.toast('storm', cold ? 'Blizzard!' : 'Cloudburst!', t + pausedNote, fast ? { label: 'Watch it at 1 day per second', speed: 1 } : null);
    } else if (ev.type === 'drought') {
      const yrs = ev.days / 365;
      let t = `For the next ${fmt(yrs)} years only ${Math.round(sim.events.drought ? sim.events.drought.pMul * 100 : 30)}% of the usual rain and snow falls, everywhere on the map, and it is ${fmt(sim.events.drought?.dT ?? 1.5)} °C hotter. Grass turns gold, then brown; groundwater sinks; forests get dry enough to burn.`;
      const act = speed < 120 || speed > 3650 ? { label: 'Watch it at 1 year per second', speed: 365 } : null;
      this.toast('drought', 'Drought!', t + pausedNote, act);
    } else if (ev.type === 'flood') {
      let t = `A ${fmt(ev.volume / 1e6)} million m³ flood wave (peak ${fmt(ev.peak)} m³/s, ${fmt(ev.days * 24)} hours) is pouring in here from upstream, like the 100-year storm hitting the hills above the map. Watch it race down the valley, scour the channel and drop sand on the flats.`;
      this.toast('flood', '100-year flood!', t + pausedNote, speed > 0.1 ? { label: 'Watch in slow motion (1 hour per second)', speed: 1 / 24 } : null);
    } else if (ev.type === 'wildfire') {
      const fuel = this.fuelAround(ev.x, ev.y, ev.r);
      let t;
      if (fuel !== null && fuel < 0.06) t = 'There is almost nothing here to burn: bare rock, snow or very sparse plants. Try a grassy or forested slope.';
      else {
        t = 'The plants here are burning. Dry fuel nearby can catch; fire runs uphill and with the wind. The black scar sheds water and mud in the next storms until grass, then shrubs, then trees grow back.';
        if (speed > 3650 && !sim.paused) t += ' At this speed the scar heals within a second.';
      }
      this.toast('wildfire', 'Wildfire!', t + (sim.paused ? ` Press ${goWord} to let it burn.` : ''), fuel !== null && fuel < 0.06 ? null : { label: speed > 120 ? 'Watch it at 1 day per second, then speed up' : 'Then watch it grow back at 1 year per second', speed: speed > 120 ? 1 : 365, later: speed > 120 });
    } else if (ev.type === 'volcano') {
      const S = ERUPTION_STYLES[ev.style] || ERUPTION_STYLES.strombolian;
      const span = ev.days >= 365 ? `${fmt(ev.days / 365)} year${ev.days === 365 ? '' : 's'}` : `${fmt(ev.days)} days`;
      const mm3 = (v) => `${fmt(v / 1e6)} million m³`;
      const t = {
        hawaiian: `For ${span} fountains of runny basalt build a small spatter cone (about ${Math.round(ev.coneHeight)} m) while ${mm3(ev.lava)} of lava pours out in rivers that run far down the valleys and set into black rock.`,
        strombolian: `For ${span} it throws out cinders that pile into a cone about ${Math.round(ev.coneHeight)} m tall, while ${mm3(ev.lava)} of basalt lava pours out at its foot and runs downhill. The lava crusts over, sets into black rock and burns or buries whatever is in its way.`,
        vulcanian: `For ${span} cannon-shot blasts throw out blocks and ash that build a steep cone about ${Math.round(ev.coneHeight)} m tall and dust the land downwind (up to ${fmt(ev.ashT * 100)} cm near the vent), while a short, thick flow of andesite lava (${mm3(ev.lava)}) creeps out at its foot.`,
        pelean: `Over ${span} ${mm3(ev.lava)} of stiff dacite lava swells into a dome over the vent, while collapses off its front send ${mm3(ev.pyro)} of glowing pyroclastic flows racing down the valleys. They burn everything and leave tuff on the valley floors.`,
        plinian: `For ${span} a column of ash and pumice towers over the land. Up to ${fmt(ev.ashT)} m of pumice falls near the vent, thinning downwind; ${mm3(ev.pyro)} of pyroclastic flows pour down the valleys and a crater ${Math.round(ev.craterD)} m deep opens. Rain will wash the loose ash into mudflows for years.`,
        phreatic: `Groundwater flashed to steam blasts a crater ${Math.round(ev.craterD)} m deep and ${Math.round(ev.craterR * 2)} m across out of the old rock over ${span}, and throws the broken rock around it in a rim about ${Math.round(ev.ringH)} m high. No new magma comes out.`,
        phreatomagmatic: `Over ${span} magma meeting groundwater explodes into fine ash, digging a maar crater ${Math.round(ev.craterD)} m below the old ground and ${fmt(ev.craterR * 2 / 1000)} km across, ringed by a tuff ring about ${Math.round(ev.ringH)} m high. Groundwater may fill it into a lake.`,
      }[ev.style] || '';
      let x = t;
      if (speed > 36 && !sim.paused) x += ' At this speed the eruption still takes a few seconds, so you can watch it unfold.';
      const quick = ev.days < 30;
      const act = quick ? (speed > 3 ? { label: 'Watch it at 1 day per second', speed: 1 } : null)
        : (speed < 3 || speed > 120 ? { label: 'Watch it at 10 days per second', speed: 10 } : null);
      this.toast('volcano', `${S.name} eruption!`, x + pausedNote, act);
    }
  }

  cancelLater() { clearTimeout(this.laterTimer); this.laterTimer = null; }

  // action: optional { label, speed } button that sets the speed dial (and plays)
  toast(kind, title, text, action = null) {
    const el = $('toast');
    // a speed button would skip or throw away a timelapse, so they are offered only in free run
    if ((this.app.tl || this.sim.paused) && action?.speed !== undefined) action = null;
    const icon = ALL_TOOLS.find((t) => t.id === kind)?.icon || TOAST_ICONS[kind] || '';
    el.className = `toast ${kind}`;
    el.innerHTML = `<div class="ticon">${icon}</div><div><b>${title}</b><p>${text}</p>${action ? `<button class="tact">${action.label}</button>` : ''}</div>`;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), action ? 14000 : 9000);
    el.onclick = (e) => {
      if (action && e.target.classList.contains('tact')) {
        this.app.setSpeed(action.speed); this.app.play();
        if (action.later) this.laterTimer = setTimeout(() => { this.laterTimer = null; this.app.setSpeed(365); }, 6000);
      }
      el.classList.remove('show');
    };
    this.lastToast = { kind, title, text, action: action?.label, at: performance.now() };
  }
}
