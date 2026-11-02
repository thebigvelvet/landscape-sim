// Weather brushes: the tool row, ray picking against the height field, the cursor ring, click and
// drag painting, and the "what just happened" message.
//
// Picking runs on the CPU against a cached copy of the ground height (bedrock + soil), refreshed
// from the GPU about once a second while a tool is selected (heights change slowly). The ray comes
// from the renderer's own inverse view-projection, so it matches what is on screen exactly,
// including the lens shift that keeps the land clear of the side panel.
import { TOOL_IDS } from '../render/renderer.js';

const $ = (id) => document.getElementById(id);

export const TOOLS = [
  { id: 'none', name: 'Look around', key: '1', tip: 'Drag to turn the view, right-drag to slide, scroll to zoom. Clicking the land does nothing.',
    icon: '<svg viewBox="0 0 24 24"><path d="M12 3c-1 0-1.6.8-1.6 1.7v7.1l-1.6-1.6c-.7-.7-1.7-.7-2.3 0-.6.6-.6 1.6 0 2.2l4.6 5.4c1 1.2 2.4 2.2 4.2 2.2h.7c2.8 0 4.6-2.1 4.6-4.9V9.6c0-.9-.7-1.6-1.6-1.6s-1.5.7-1.5 1.6v-1c0-.9-.7-1.6-1.6-1.6s-1.6.7-1.6 1.6v-.5c0-.9-.7-1.6-1.6-1.6V4.7C13.6 3.8 13 3 12 3z"/></svg>' },
  { id: 'storm', name: 'Storm', key: '2', tip: 'Click to drop a cloudburst on that spot: three days of very heavy rain (or snow when it is cold), up to 240 mm in the middle. Drag to steer the storm.',
    icon: '<svg viewBox="0 0 24 24"><path d="M7 15a5 5 0 0 1-.6-10 6 6 0 0 1 11.3 1.6A4.2 4.2 0 0 1 17 15z"/><path d="M8 17l-1.5 4M12 17l-1.5 4M16 17l-1.5 4" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M12.5 14.5l-2 3.5h2.6l-1.6 3.5" stroke-width="1.6" fill="none" stroke-linejoin="round"/></svg>' },
  { id: 'drought', name: 'Drought', key: '3', tip: 'Click anywhere to start a five-year drought over the whole map: little rain or snow and hotter air. Grass turns gold then brown, groundwater falls, and dry forests burn easily.',
    icon: '<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="4.2"/><path d="M12 1.5v2.6M12 16v2.2M3.5 10h2.6M18 10h2.5M6 4l1.8 1.8M16.2 14.2l1.8 1.8M6 16l1.8-1.8M16.2 5.8L18 4" stroke-width="1.8" stroke-linecap="round" fill="none"/><path d="M3 21.5l3-2 2.5 1.5 3-2.5 2.5 2 3-1.5 3 2.5" stroke-width="1.5" fill="none" stroke-linejoin="round"/></svg>' },
  { id: 'flood', name: 'Flood', key: '4', tip: 'Click a valley or stream to send a 100-year flood down it: a 12-hour flood wave (peak 150 cubic metres per second) pours in at that spot from upstream. Best watched at 1 day per second.',
    icon: '<svg viewBox="0 0 24 24"><path d="M2 9c2 0 2-1.6 4-1.6S8 9 10 9s2-1.6 4-1.6S16 9 18 9s2-1.6 4-1.6M2 14c2 0 2-1.6 4-1.6S8 14 10 14s2-1.6 4-1.6 2 1.6 4 1.6 2-1.6 4-1.6M2 19c2 0 2-1.6 4-1.6S8 19 10 19s2-1.6 4-1.6 2 1.6 4 1.6 2-1.6 4-1.6" stroke-width="2" stroke-linecap="round" fill="none"/></svg>' },
  { id: 'wildfire', name: 'Wildfire', key: '5', tip: 'Click or drag to set the plants on fire. Dry plants nearby can catch, and fire runs uphill and with the wind. Burned slopes shed water and mud in the next storms until plants grow back.',
    icon: '<svg viewBox="0 0 24 24"><path d="M12.3 2.2c.4 3-1.5 4.6-3 6.3-1.6 1.8-3 3.6-3 6.4A5.8 5.8 0 0 0 12 21a5.8 5.8 0 0 0 5.8-5.9c0-2.5-1.2-4.6-2.7-6.3-.3 1.4-1 2.6-2.2 3.2.6-3.2-.1-6.6-.6-9.8z"/><path d="M12 20.5c-1.6 0-2.8-1.2-2.8-2.8 0-1.6 1.3-2.6 2.2-3.8.2 1 .8 1.6 1.6 1.9.4-.6.5-1.2.6-1.8.9 1 1.2 2.2 1.2 3.4 0 1.7-1.2 3.1-2.8 3.1z" fill="#ffd27a"/></svg>' },
];

export class BrushTool {
  constructor(app) {
    this.app = app;
    this.tool = 'none';
    this.radius = 15;
    this.intensity = 1;
    this.H = null; this.V = null; this.hN = 0; this.hTime = 0; this.hPending = false;
    this.down = null;
    this.buildRow();
    this.bind();
  }

  get renderer() { return this.app.renderer; }
  get sim() { return this.app.sim; }

  buildRow() {
    const row = $('tools');
    row.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'tool' + (t.id === 'none' ? ' active' : '');
      b.dataset.tool = t.id;
      b.innerHTML = `${t.icon}<span>${t.name}</span>`;
      b.title = `${t.name} (key ${t.key})`;
      b.addEventListener('click', () => this.setTool(t.id));
      b.addEventListener('mouseenter', () => { $('tool-help').textContent = t.tip; });
      b.addEventListener('mouseleave', () => { $('tool-help').textContent = TOOLS.find((q) => q.id === this.tool).tip; });
      row.appendChild(b);
    }
    $('tool-help').textContent = TOOLS[0].tip;
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
  }

  setTool(id) {
    if (id === 'fire') id = 'wildfire';
    if (!TOOLS.some((t) => t.id === id)) id = 'none';
    this.tool = id;
    for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === id);
    $('tool-help').textContent = TOOLS.find((t) => t.id === id).tip;
    document.body.classList.toggle('painting', id !== 'none');
    if (id === 'none') this.renderer.setCursor(false);
    else this.refreshHeights(true);
  }

  // ---- height field cache for picking ----
  async refreshHeights(force = false) {
    const sim = this.sim;
    if (!sim.world || this.hPending) return;
    const now = performance.now();
    if (!force && now - this.hTime < 1200 && this.hN === sim.world.N) return;
    this.hPending = true;
    try {
      const [b, s, v] = await Promise.all([sim.readLayer('bedrock'), sim.readLayer('soil'), sim.readLayer('veg')]);
      for (let i = 0; i < b.length; i++) b[i] += s[i];
      this.H = b; this.V = v; this.hN = sim.world.N; this.hTime = performance.now();
    } finally { this.hPending = false; }
  }

  heightAt(gx, gy) {
    const N = this.hN, H = this.H;
    const x = Math.min(Math.max(gx, 0), N - 1.001), y = Math.min(Math.max(gy, 0), N - 1.001);
    const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
    const i = y0 * N + x0;
    return (H[i] * (1 - tx) + H[i + 1] * tx) * (1 - ty) + (H[i + N] * (1 - tx) + H[i + N + 1] * tx) * ty;
  }

  /** Screen point (client px) -> grid cell {x, y} on the terrain, or null if the ray misses. */
  pick(clientX, clientY) {
    const r = this.renderer, sim = this.sim;
    if (!this.H || !r.lastInvViewProj || this.hN !== sim.world?.N) return null;
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
      this.refreshHeights();
      const p = this.pick(e.clientX, e.clientY);
      this.renderer.setCursor(!!p, p?.x, p?.y, this.radius, TOOL_IDS[this.tool]);
      if (p && this.down) this.dragTo(p);
    });
    cv.addEventListener('pointerleave', () => this.renderer.setCursor(false));
    cv.addEventListener('pointerdown', (e) => {
      if (this.tool === 'none' || e.button !== 0 || e.shiftKey) return;
      const p = this.pick(e.clientX, e.clientY);
      if (!p) { this.toast('miss', 'Click on the land', 'That click missed the map. Point at the ground and try again.'); return; }
      cv.setPointerCapture(e.pointerId);
      const ev = this.apply(this.tool, p.x, p.y);
      this.down = { id: ev?.id, last: performance.now(), x: p.x, y: p.y };
    });
    const up = (e) => { this.down = null; cv.releasePointerCapture?.(e.pointerId); };
    cv.addEventListener('pointerup', up);
    cv.addEventListener('pointercancel', up);
    window.addEventListener('keydown', (e) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
      if (e.key === 'Escape') this.setTool('none');
      const t = TOOLS.find((q) => q.key === e.key);
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

  /** Same as clicking: start the event, show the ripple and the message. */
  apply(type, x, y, opts = {}) {
    if (type === 'fire') type = 'wildfire';
    const o = { x, y, radius: opts.radius ?? this.radius, intensity: opts.intensity ?? this.intensity, days: opts.days };
    if (type === 'drought') delete o.radius;
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
    const pausedNote = sim.paused ? ' Press play to let it happen.' : '';
    const fmt = (v) => v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(v < 10 ? 1 : 0);
    if (ev.type === 'storm') {
      const mm = ev.centreMm;
      const what = cold ? 'snow (as water)' : 'rain';
      let t = `Up to ${fmt(mm)} mm of ${what} will fall in the middle over ${fmt(ev.days)} days, about ${Math.round((mm / ev.days) / normal)} times a normal wet day here. Watch the gullies run and the streams turn muddy.`;
      if (fast) t += ' At this speed the storm is over in a blink, but every drop and every grain of mud it moves is counted.';
      this.toast('storm', cold ? 'Blizzard!' : 'Cloudburst!', t + pausedNote);
    } else if (ev.type === 'drought') {
      const yrs = ev.days / 365;
      let t = `For the next ${fmt(yrs)} years only ${Math.round(sim.events.drought ? sim.events.drought.pMul * 100 : 30)}% of the usual rain and snow falls, everywhere on the map, and it is ${fmt(sim.events.drought?.dT ?? 1.5)} °C hotter. Grass turns gold, then brown; groundwater sinks; forests get dry enough to burn.`;
      if (speed < 120) t += ' Speed up to about 1 year per second to watch the land bake.';
      else if (speed > 3650) t += ' At this speed five years pass in a blink; slow to 1 year per second to watch it.';
      this.toast('drought', 'Drought!', t + pausedNote);
    } else if (ev.type === 'flood') {
      let t = `A ${fmt(ev.volume / 1e6)} million m³ flood wave (peak ${fmt(ev.peak)} m³/s, ${fmt(ev.days * 24)} hours) is pouring in here from upstream, like the 100-year storm hitting the hills above the map. Watch it race down the valley, scour the channel and drop sand on the flats.`;
      if (speed > 3) t += ' Slow down to 1 day per second to watch the surge travel.';
      this.toast('flood', '100-year flood!', t + pausedNote);
    } else if (ev.type === 'wildfire') {
      const fuel = this.fuelAround(ev.x, ev.y, ev.r);
      let t;
      if (fuel !== null && fuel < 0.06) t = 'There is almost nothing here to burn: bare rock, snow or very sparse plants. Try a grassy or forested slope.';
      else {
        t = 'The plants here are burning. Dry fuel nearby can catch; fire runs uphill and with the wind. The black scar sheds water and mud in the next storms until grass, then shrubs, then trees grow back.';
        if (speed > 3650 && !sim.paused) t += ' At this speed the scar heals within a second; slow to about 1 year per second to watch the forest return.';
      }
      this.toast('wildfire', 'Wildfire!', t + (sim.paused ? ' Press play to let it burn.' : ''));
    }
  }

  toast(kind, title, text) {
    const el = $('toast');
    const icon = TOOLS.find((t) => t.id === kind)?.icon || '';
    el.className = `toast ${kind}`;
    el.innerHTML = `<div class="ticon">${icon}</div><div><b>${title}</b><p>${text}</p></div>`;
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => el.classList.remove('show'), 9000);
    el.onclick = () => el.classList.remove('show');
    this.lastToast = { kind, title, text };
  }
}
