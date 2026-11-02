// World: an N x N grid, one GPU storage buffer per layer (f32, row-major, index = y*N + x).
//
// Contract layers (exact names): bedrock, soil, water, sediment, snowSWE, frostDepth, temp,
// velX, velY, flux (4 floats per cell: -x, +x, -y, +y outgoing volume flux, m^3/s).
//
// Engine extras:
//   water2, sediment2  ping-pong partners. The water module swaps them every sub-step and always
//                      runs an EVEN number of sub-steps, so at every frame boundary the canonical
//                      `water` / `sediment` buffers hold the current state (safe for other modules,
//                      the renderer and stats).
//   groundwater        shallow subsurface store (m of water) - part of the auditable water balance.
//   slope              sin(terrain tilt), written by the flux kernel, read by erosion.
//   acc                vec4 per cell: (precip, outflow, evap, sedimentOut) in metres, accumulated over
//                      one frame and folded into a GPU log by the reduction kernel.
//   thermalDelta       vec2 per cell scratch for the race-free talus/creep kernel.
//   initHeight         terrain height at load, moved along by the sculpt brushes (erosion overlay,
//                      solids balance and edge base level all measure from it).
//   spring             recent spring discharge (m/day), for display; see sim/groundwater.js.
//   veg                plant cover 0..1 (sim/vegetation.js).
//   burn               recent burn severity 0..1, decays over a few years.
//   plant              vec4 per cell: (woody fraction of the cover 0..1, moisture memory 0..1 =
//                      groundwater fill smoothed over ~1 year, ground height at the last batch,
//                      active fire 0..1).
//   fireNext           f32 scratch: next fire state (race-free fire spread).
//   sculptScratch      f32 scratch for the sculpt brushes (smoothing copy, undo deltas), sim/sculpt.js.
//   statPartials, accPartials, fluxLog   reduction scratch / log ring.

export const LAYERS = ['bedrock', 'soil', 'water', 'sediment', 'snowSWE', 'frostDepth', 'temp', 'velX', 'velY'];
export const EXTRA1 = ['water2', 'sediment2', 'groundwater', 'slope', 'initHeight', 'spring', 'veg', 'burn', 'fireNext', 'sculptScratch'];
export const STAT_GROUPS = 256;   // workgroups in the stats reduction
export const STAT_STRIDE = 16;    // floats per partial
export const LOG_SIZE = 4096;     // entries in the GPU flux log ring

export class World {
  constructor(device, { N = 512, cellSize = 10 } = {}) {
    this.device = device;
    this.N = N;
    this.cellSize = cellSize;
    this.cells = N * N;
    this.buffers = {};
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
    const mk = (name, floatsPerCell = 1) => {
      this.buffers[name] = device.createBuffer({ size: this.cells * 4 * floatsPerCell, usage, label: name });
    };
    for (const n of LAYERS) mk(n);
    for (const n of EXTRA1) mk(n);
    mk('flux', 4);
    mk('acc', 4);
    mk('thermalDelta', 2);
    mk('gwFlux', 4);  // groundwater transfers through the four faces (-x, +x, -y, +y)
    mk('plant', 4);   // (woody, moisture memory, previous ground height, fire)
    mk('light', 4);   // renderer: (sun visibility, ambient occlusion, groundwater fill, springs), from render/lighting.js
    this.buffers.statPartials = device.createBuffer({ size: STAT_GROUPS * STAT_STRIDE * 4, usage, label: 'statPartials' });
    this.buffers.accPartials = device.createBuffer({ size: STAT_GROUPS * 16, usage, label: 'accPartials' });
    this.buffers.fluxLog = device.createBuffer({ size: LOG_SIZE * 16, usage, label: 'fluxLog' });
    this.buffers.plantPartials = device.createBuffer({ size: STAT_GROUPS * 16, usage, label: 'plantPartials' });
    // expose layers directly too: world.bedrock etc.
    for (const k in this.buffers) this[k] = this.buffers[k];
    this.height0 = this.buffers.initHeight;   // name used by the renderer shaders
    this.bytes = Object.values(this.buffers).reduce((s, b) => s + b.size, 0);
  }

  // Upload initial state from CPU arrays (Float32Array of length N*N). Missing layers are zeroed.
  upload(layers) {
    const q = this.device.queue;
    const zero = new Float32Array(this.cells * 4);
    for (const name of [...LAYERS, ...EXTRA1, 'flux', 'acc', 'thermalDelta', 'gwFlux', 'plant']) {
      const buf = this.buffers[name];
      const src = layers[name];
      if (src) q.writeBuffer(buf, 0, src);
      else {
        // zero-fill in chunks of the scratch array
        for (let off = 0; off < buf.size; off += zero.byteLength) q.writeBuffer(buf, off, zero, 0, Math.min(zero.byteLength, buf.size - off) / 4);
      }
    }
    q.writeBuffer(this.buffers.fluxLog, 0, new Float32Array(LOG_SIZE * 4));
  }

  destroy() {
    for (const b of Object.values(this.buffers)) b.destroy();
    this.buffers = {};
  }
}
