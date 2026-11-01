// Climate: seasonal temperature/precipitation curves, elevation lapse rate, presets and storm events.
//
// The CPU side produces a plain `climate` object each frame (contract). The same curves are
// mirrored in WGSL (CLIMATE_WGSL) so the column kernel can sub-cycle through the season
// on the GPU without CPU round trips.
//
//   T(day, z)  = tSea + tAmp * cos(2pi (day - tPeakDay)/365) - lapse * z/1000 + offset   [degC]
//   P(day, z)  = pMean * max(0, 1 + pSeas * cos(2pi (day - pPeakDay)/365)) * orographic(z) * storm  [mm/day]

export const PRESETS = {
  'Utah desert': {
    tSea: 21.5, tAmp: 13, lapse: 6.5, pMean: 0.65, pSeas: 0.35, pPeakDay: 225, tPeakDay: 200, dtr: 17,
    orog: 0.6, ksat: 0.012, gwMax: 0.18, etMul: 1.3, baseElevation: 1400,
    colors: { soil: [0.71, 0.45, 0.30], veg: [0.47, 0.50, 0.30], rock: [0.62, 0.36, 0.26] },
  },
  'Colorado alpine': {
    tSea: 20, tAmp: 11, lapse: 6.5, pMean: 2.2, pSeas: 0.3, pPeakDay: 60, tPeakDay: 200, dtr: 15,
    orog: 0.5, ksat: 0.025, gwMax: 0.25, etMul: 1.0, baseElevation: 2900,
    colors: { soil: [0.45, 0.38, 0.28], veg: [0.20, 0.36, 0.17], rock: [0.50, 0.48, 0.46] },
  },
  'Pacific NW wet': {
    tSea: 11, tAmp: 7, lapse: 6.0, pMean: 6.0, pSeas: 0.75, pPeakDay: 350, tPeakDay: 205, dtr: 8,
    orog: 0.8, ksat: 0.04, gwMax: 0.35, etMul: 0.8, baseElevation: 150,
    colors: { soil: [0.32, 0.27, 0.20], veg: [0.12, 0.33, 0.13], rock: [0.38, 0.39, 0.38] },
  },
  'Temperate': {
    tSea: 12, tAmp: 10, lapse: 6.5, pMean: 2.5, pSeas: 0.15, pPeakDay: 180, tPeakDay: 200, dtr: 10,
    orog: 0.4, ksat: 0.03, gwMax: 0.3, etMul: 1.0, baseElevation: 300,
    colors: { soil: [0.42, 0.34, 0.24], veg: [0.27, 0.42, 0.18], rock: [0.48, 0.46, 0.43] },
  },
};

export const PRESET_NAMES = Object.keys(PRESETS);

export const CLIMATE_WGSL = /* wgsl */`
fn airTemp(doy : f32, z : f32) -> f32 {
  return P.tSea + P.tAmp * cos(2.0 * PI * (doy - P.tPeakDay) / 365.0) - P.lapse * z * 0.001;
}
// precipitation in metres/day
fn precipRate(doy : f32, z : f32) -> f32 {
  let seas = max(0.0, 1.0 + P.pSeas * cos(2.0 * PI * (doy - P.pPeakDay) / 365.0));
  let oro = clamp(1.0 + P.orog * (z - P.zRef) * 0.001, 0.3, 2.5);
  return P.pMean * 0.001 * seas * oro * P.stormMul;
}
`;

export class Climate {
  constructor() {
    this.presetName = 'Colorado alpine';
    this.tempOffset = 0;      // degC
    this.precipMul = 1;       // x
    this.seasonality = 1;     // x on amplitudes
    this.stormDaysLeft = 0;
    this.stormMul = 12;
  }
  get preset() { return PRESETS[this.presetName] || PRESETS['Colorado alpine']; }
  setPreset(name) { if (PRESETS[name]) this.presetName = name; }
  triggerStorm(days = 3, mul = 12) { this.stormDaysLeft = days; this.stormMul = mul; }

  // Effective storm multiplier averaged over an interval of D days (so a 3-day storm inside a
  // 16-year frame adds exactly 3 storm-days of extra rain, not 16 years of it).
  stormFactor(D) {
    if (this.stormDaysLeft <= 0 || D <= 0) return 1;
    const covered = Math.min(this.stormDaysLeft, D);
    return 1 + (this.stormMul - 1) * covered / D;
  }
  consume(D) { this.stormDaysLeft = Math.max(0, this.stormDaysLeft - D); }

  airTempAt(dayOfYear, z) {
    const p = this.preset;
    return p.tSea + this.tempOffset + p.tAmp * this.seasonality * Math.cos(2 * Math.PI * (dayOfYear - p.tPeakDay) / 365) - p.lapse * z / 1000;
  }
  precipAt(dayOfYear) {
    const p = this.preset;
    return p.pMean * this.precipMul * Math.max(0, 1 + Math.min(1, p.pSeas * this.seasonality) * Math.cos(2 * Math.PI * (dayOfYear - p.pPeakDay) / 365));
  }

  // Contract object (plain): produced every frame.
  produce(dayOfYear, refElevation = 0, D = 1) {
    const p = this.preset;
    const tSea = this.airTempAt(dayOfYear, 0);
    return {
      dayOfYear,
      airTempSeaLevel: tSea,
      lapseRate: p.lapse,
      precipRate_mm_per_day: this.precipAt(dayOfYear) * this.stormFactor(D),
      isSnow: this.airTempAt(dayOfYear, refElevation) < 0.5,
      airTempAtRef: this.airTempAt(dayOfYear, refElevation),
      storm: this.stormDaysLeft > 0,
      preset: this.presetName,
    };
  }

  // Uniform fields consumed by the WGSL curves.
  uniforms(D, refElevation) {
    const p = this.preset;
    return {
      tSea: p.tSea + this.tempOffset, tAmp: p.tAmp * this.seasonality, lapse: p.lapse,
      pMean: p.pMean * this.precipMul, pSeas: Math.min(1, p.pSeas * this.seasonality), pPeakDay: p.pPeakDay,
      tPeakDay: p.tPeakDay, dtr: p.dtr, stormMul: this.stormFactor(D), zRef: refElevation, orog: p.orog,
      ksat: p.ksat, gwMax: p.gwMax, etMul: p.etMul,
    };
  }
}

// Module interface (contract). The climate "step" has no GPU work of its own: it is evaluated on
// the GPU inside the column kernel (see column.js) through CLIMATE_WGSL + the shared uniforms.
export default {
  name: 'climate',
  init() {},
  step() {},
};
