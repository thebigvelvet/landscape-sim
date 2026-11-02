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
//   initHeight         terrain height at load (for the erosion/deposition overlay).
//   spring             recent spring discharge (m/day), for display; see sim/groundwater.js.
//   veg                vegetation cover 0..1 (round 2, sim/vegetation.js).
//   burn               recent burn severity 0..1, decays over a few years.
//   erodMul            erodibility multiplier from plants and fire, read by the erosion exchange.
//   vegAux             vec4 per cell: (growing-season soil moisture W, infiltration multiplier,
//                      copy of veg for the column kernel, ground height at the last plant step).
//   fire               vec2 scratch for the wildfire spread (ping-pong flags), only used by brushes.
//   pick               small scratch for GPU ray picking (sim/brushes.js).
//   statPartials, accPartials, fluxLog   reduction scratch / log ring.

export const LAYERS = ['bedrock', 'soil', 'water', 'sediment', 'snowSWE', 'frostDepth', 'temp', 'velX', 'velY'];
export const EXTRA1 = ['water2', 'sediment2', 'groundwater', 'slope', 'initHeight', 'spring', 'veg', 'burn', 'erodMul'];
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
    mk('vegAux', 4);  // (W moisture, infiltration multiplier, veg copy, zPrev), see sim/vegetation.js
    mk('fire', 2);    // wildfire spread flags (ping-pong), brushes only
    // renderer: two vec4 per cell. [2i] = (sun visibility, ambient occlusion, groundwater fill, springs)
    // from render/lighting.js; [2i+1] = (veg, burn, drought stress, warmest-month temperature) from
    // sim/vegetation.js
    mk('light', 8);
    this.buffers.statPartials = device.createBuffer({ size: STAT_GROUPS * STAT_STRIDE * 4, usage, label: 'statPartials' });
    this.buffers.accPartials = device.createBuffer({ size: STAT_GROUPS * 16, usage, label: 'accPartials' });
    this.buffers.fluxLog = device.createBuffer({ size: LOG_SIZE * 16, usage, label: 'fluxLog' });
    this.buffers.vegPartials = device.createBuffer({ size: STAT_GROUPS * 16, usage, label: 'vegPartials' });
    this.buffers.pick = device.createBuffer({ size: 256 * 16, usage, label: 'pick' });
    // expose layers directly too: world.bedrock etc.
    for (const k in this.buffers) this[k] = this.buffers[k];
    this.height0 = this.buffers.initHeight;   // name used by the renderer shaders
    this.bytes = Object.values(this.buffers).reduce((s, b) => s + b.size, 0);
  }

  // Upload initial state from CPU arrays (Float32Array of length N*N). Missing layers are zeroed.
  upload(layers) {
    const q = this.device.queue;
    const zero = new Float32Array(this.cells * 4);
    for (const name of [...LAYERS, ...EXTRA1, 'flux', 'acc', 'thermalDelta', 'gwFlux', 'vegAux', 'fire', 'light']) {
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
