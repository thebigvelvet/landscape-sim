// One shared uniform block ("frame plan") for every simulation kernel.
// It is written ONCE per frame/batch with a single queue.writeBuffer, so there is no
// per-dispatch uniform churn and every pipeline shares the same bind-group layout slot 0.

import { TABLE_LEN, STRATA_PARAM_FIELDS } from './strata.js';

export const VENT_EXTRA = ['lw', 'px', 'py', 'pr', 'pd', 'ct', 'ck', 'cu', 'g0', 'g1', 'cD', 'cR', 'rH', 'rL', 'ru', 'aT', 'aL', 'awx', 'awy', 'sp', 'k0', 'k1'];

// [name, type] - all 4 bytes except the bed table at the end. Order is the memory layout.
export const PARAM_FIELDS = [
  ['N', 'u32'], ['frame', 'u32'], ['logSize', 'u32'], ['nSub', 'u32'],
  ['cellSize', 'f32'], ['cellArea', 'f32'], ['dtH', 'f32'], ['g', 'f32'],
  // time scaling
  ['aW', 'f32'], ['fR', 'f32'], ['morph', 'f32'], ['D', 'f32'],
  ['dayStart', 'f32'], ['spanDays', 'f32'], ['yrs', 'f32'], ['nInner', 'f32'],
  // climate
  ['tSea', 'f32'], ['tAmp', 'f32'], ['lapse', 'f32'], ['pMean', 'f32'],
  ['pSeas', 'f32'], ['pPeakDay', 'f32'], ['dtr', 'f32'], ['stormMul', 'f32'],
  ['zRef', 'f32'], ['orog', 'f32'], ['ddf', 'f32'], ['ksat', 'f32'],
  ['gwMax', 'f32'], ['etMul', 'f32'], ['kBase', 'f32'], ['frostK', 'f32'],
  ['thawK', 'f32'], ['kWeather', 'f32'], ['kChem', 'f32'], ['eSurf', 'f32'],
  ['kTrans', 'f32'], ['tPeakDay', 'f32'], ['sublim', 'f32'], ['datum', 'f32'],
  // erosion / transport
  ['kc', 'f32'], ['ks', 'f32'], ['kd', 'f32'], ['kRock', 'f32'],
  ['minSlope', 'f32'], ['dzMax', 'f32'], ['vMax', 'f32'], ['manning', 'f32'],
  ['talusTan', 'f32'], ['rockTan', 'f32'], ['thermalRate', 'f32'], ['creepFrac', 'f32'],
  ['rockRate', 'f32'], ['hDry', 'f32'], ['kGw', 'f32'], ['gwPor', 'f32'],
  // groundwater; snow avalanches (sim/snow.js); sand angle of repose (sim/wind.js)
  ['gwDt', 'f32'], ['avalTan', 'f32'], ['avalKill', 'f32'], ['sandTan', 'f32'],
  // plants and fire (see sim/vegetation.js)
  ['vegInit', 'f32'], ['fireWeather', 'f32'], ['windX', 'f32'], ['windY', 'f32'],
  // sediment beds (sim/deposits.js): current epoch (mod 8192), on/off; wind (sim/wind.js): sand share
  // of plain soil, on/off
  ['depEpoch', 'f32'], ['depOn', 'f32'], ['windSandy', 'f32'], ['windOn', 'f32'],
  // glaciers (sim/glacier.js): snow -> ice, ice melt, on/off, flow iterations this batch
  ['firnSWE', 'f32'], ['firnTau', 'f32'], ['ddfIce', 'f32'], ['glacOn', 'f32'],
  ['glacK', 'f32'], ['iceYield', 'f32'], ['iceA', 'f32'], ['kGlac', 'f32'],
  // painted weather events (see sim/events.js): 4 local storms (centre x, y in cells, radius in
  // cells, extra precipitation at the centre in m/day averaged over the batch) and 2 flood sources
  // (centre, radius, water depth added per cell per hydraulic sub-step)
  ['s0x', 'f32'], ['s0y', 'f32'], ['s0r', 'f32'], ['s0a', 'f32'],
  ['s1x', 'f32'], ['s1y', 'f32'], ['s1r', 'f32'], ['s1a', 'f32'],
  ['s2x', 'f32'], ['s2y', 'f32'], ['s2r', 'f32'], ['s2a', 'f32'],
  ['s3x', 'f32'], ['s3y', 'f32'], ['s3r', 'f32'], ['s3a', 'f32'],
  ['f0x', 'f32'], ['f0y', 'f32'], ['f0r', 'f32'], ['f0d', 'f32'],
  ['f1x', 'f32'], ['f1y', 'f32'], ['f1r', 'f32'], ['f1d', 'f32'],
  // volcanoes (sim/volcano.js): lava flow iterations this batch, seconds of lava time per iteration,
  // yield depth (m), viscosity (Pa s); then 2 vents: centre (cells), throat radius (cells), cone height
  // before and after this batch (m), lava source centre and radius (cells), lava added per source
  // cell per iteration (m)
  ['volcOn', 'f32'], ['lavaK', 'f32'], ['lavaDt', 'f32'], ['lavaYield', 'f32'],
  ['lavaVisc', 'f32'], ['coneTan', 'f32'], ['volcP0', 'f32'], ['volcP1', 'f32'],
  ['v0x', 'f32'], ['v0y', 'f32'], ['v0r', 'f32'], ['v0h0', 'f32'],
  ['v0h1', 'f32'], ['v0lx', 'f32'], ['v0ly', 'f32'], ['v0lr', 'f32'],
  ['v0ld', 'f32'], ['v1x', 'f32'], ['v1y', 'f32'], ['v1r', 'f32'],
  ['v1h0', 'f32'], ['v1h1', 'f32'], ['v1lx', 'f32'], ['v1ly', 'f32'],
  ['v1lr', 'f32'], ['v1ld', 'f32'], ['volcP2', 'f32'], ['volcP3', 'f32'],
  // eruption styles (volcano.js ERUPTION_STYLES), per vent: stiffness (log10 viscosity) of the main
  // lava; pyroclastic-flow source centre, radius (cells) and depth added per iteration (m); cone flank
  // tan, rim factor and rock type; share of the eruption done before/after this batch; explosion
  // crater depth and radius (m); ejecta ring height and fall-off length (m) and rock type; ash
  // thickness at the vent (m), fall-off length (m) and downwind direction
  ...VENT_EXTRA.flatMap((n) => [0, 1].map((k) => [`v${k}${n}`, 'f32'])),
  // karst and salt (sim/column.js): dissolution rate (m/yr of soluble rock), landscape years this batch
  ['kDiss', 'f32'], ['yrsE', 'f32'],
  // karst valleys (sim/karst.js): rock dissolved per m of water sunk, and at the foot of wet walls (m/yr)
  ['kRech', 'f32'], ['kFoot', 'f32'],
  // rock layers (sim/strata.js): on/off, top of the stack (m, bedrock frame), dip, monocline, fold
  ...STRATA_PARAM_FIELDS.map((n) => [n, 'f32']),
  // rock table (strata.js TB layout: beds, faults, domes, anomalies, joints, basement); must stay last
  ['stBeds', `array<vec4<f32>, ${TABLE_LEN}>`],
];
const SCALARS = PARAM_FIELDS.length - 1;

export const PARAMS_WGSL = `struct Params {\n${PARAM_FIELDS.map(([n, t]) => `  ${n} : ${t},`).join('\n')}\n};\n`;
export const PARAMS_BYTES = Math.ceil((SCALARS * 4) / 16) * 16 + TABLE_LEN * 16;

export class ParamBlock {
  constructor(device) {
    this.device = device;
    this.buffer = device.createBuffer({ size: PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'params' });
    this.raw = new ArrayBuffer(PARAMS_BYTES);
    this.f = new Float32Array(this.raw);
    this.u = new Uint32Array(this.raw);
    this.index = {};
    PARAM_FIELDS.forEach(([n, t], i) => { this.index[n] = [i, t]; });
    this.values = {};
  }
  set(obj) {
    for (const k in obj) {
      const e = this.index[k];
      if (!e) continue;
      const v = obj[k];
      if (e[1] === 'u32') this.u[e[0]] = v >>> 0; else this.f[e[0]] = Number.isFinite(v) ? v : 0;
      this.values[k] = v;
    }
  }
  // array field (the rock table): copy floats in at its offset
  setArray(name, data) { this.f.set(data, Math.ceil(SCALARS / 4) * 4); }
  upload() { this.device.queue.writeBuffer(this.buffer, 0, this.raw); }
}
