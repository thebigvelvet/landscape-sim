// Weather brushes on the 3D map: pick a tool, then click or drag on the land.
//   Storm / Flood   click to start one at that spot; keep the button down and drag to steer it.
//   Wildfire        click to light a fire; drag to keep lighting along the path.
//   Drought         click anywhere: it covers the whole map.
// Right-drag still slides the view and the wheel still zooms. "Look around" (or Esc) gives the
// left button back to turning the view.
//
// Picking is asynchronous (GPU ray cast, see sim/pick.js); at most one pick is in flight and the
// newest pointer position wins, so dragging never queues up stale work.

export const TOOLS = ['off', 'storm', 'drought', 'flood', 'wildfire'];
const TOOL_CODE = { off: 0, storm: 1, drought: 2, flood: 3, wildfire: 4 };

export class BrushController {
  constructor(app) {
    this.app = app;
    this.tool = 'off';
    this.radiusM = 400;
    this.inFlight = false;
    this.pending = null;      // { clientX, clientY, kind: 'hover'|'down'|'drag' }
    this.painting = false;
    this.activeId = null;     // storm/flood being steered
    this.lastFire = null;
    this.hover = null;
    const canvas = app.renderer.canvas;
    this.canvas = canvas;
    app.renderer.camera.intercept = (e) => this.onDown(e);
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => { if (!this.painting) this.app.renderer.brush = null; this.hover = null; });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.setTool('off'); });
  }

  get radiusCells() { return this.radiusM / (this.app.sim.world?.cellSize || 10); }

  setTool(name) {
    this.tool = TOOLS.includes(name) ? name : 'off';
    this.canvas.style.cursor = this.tool === 'off' ? '' : 'crosshair';
    if (this.tool === 'off') { this.app.renderer.brush = null; this.painting = false; }
    this.onToolChanged?.(this.tool);
  }

  onDown(e) {
    if (this.tool === 'off' || e.button !== 0 || e.shiftKey) return false;
    this.painting = true;
    this.activeId = null;
    this.lastFire = null;
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    this.request(e, 'down');
    return true;    // consumed: the camera does not orbit
  }

  onMove(e) {
    if (this.tool === 'off') return;
    this.request(e, this.painting ? 'drag' : 'hover');
  }

  onUp(e) {
    if (!this.painting) return;
    this.painting = false;
    this.activeId = null;
    try { this.canvas.releasePointerCapture(e.pointerId); } catch { /* synthetic events */ }
  }

  request(e, kind) {
    const prev = this.pending;
    // a 'down' must never be overwritten by a later hover/drag before it is applied
    this.pending = { clientX: e.clientX, clientY: e.clientY, kind: prev?.kind === 'down' ? 'down' : kind };
    if (!this.inFlight) this.next();
  }

  ndc(clientX, clientY) {
    const r = this.canvas.getBoundingClientRect();
    return [((clientX - r.left) / r.width) * 2 - 1, 1 - ((clientY - r.top) / r.height) * 2];
  }

  async next() {
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    this.inFlight = true;
    try {
      const [nx, ny] = this.ndc(job.clientX, job.clientY);
      const hit = await this.app.pickNDC(nx, ny);
      this.apply(job.kind, hit);
    } catch (err) {
      console.error(err);
    } finally {
      this.inFlight = false;
      if (this.pending) this.next();
    }
  }

  apply(kind, hit) {
    const r = this.app.renderer;
    if (this.tool === 'off') { r.brush = null; return; }
    if (!hit) { if (!this.painting) r.brush = null; return; }
    const rc = this.radiusCells;
    r.brush = { x: hit.x, y: hit.y, r: this.tool === 'drought' ? 0 : rc, tool: TOOL_CODE[this.tool] };
    this.hover = hit;
    const sim = this.app.sim;
    if (kind === 'down') {
      const ev = sim.brush(this.tool, { x: hit.x, y: hit.y, radius: rc });
      if (ev && (this.tool === 'storm' || this.tool === 'flood')) this.activeId = ev.id;
      if (this.tool === 'wildfire') this.lastFire = hit;
    } else if (kind === 'drag' && this.painting) {
      if (this.activeId != null) sim.events.move(this.activeId, hit.x, hit.y);
      else if (this.tool === 'wildfire') {
        if (!this.lastFire || Math.hypot(hit.x - this.lastFire.x, hit.y - this.lastFire.y) > rc * 0.6) {
          sim.brush('wildfire', { x: hit.x, y: hit.y, radius: rc });
          this.lastFire = hit;
        }
      }
    }
  }
}
