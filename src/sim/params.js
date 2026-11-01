// One shared uniform block ("frame plan") for every simulation kernel.
// It is written ONCE per frame/batch with a single queue.writeBuffer, so there is no
// per-dispatch uniform churn and every pipeline shares the same bind-group layout slot 0.

// [name, type] - all 4 bytes. Order is the memory layout.
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
  // groundwater
  ['gwDt', 'f32'], ['pad1', 'f32'], ['pad2', 'f32'], ['pad3', 'f32'],
];

export const PARAMS_WGSL = `struct Params {\n${PARAM_FIELDS.map(([n, t]) => `  ${n} : ${t},`).join('\n')}\n};\n`;
export const PARAMS_BYTES = Math.ceil((PARAM_FIELDS.length * 4) / 16) * 16;

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
  upload() { this.device.queue.writeBuffer(this.buffer, 0, this.raw); }
}
