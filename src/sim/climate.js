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
    orog: 0.6, ksat: 0.012, gwMax: 0.18, etMul: 1.3, baseElevation: 1400, wetFrac: 0.10, stormLen: 1.5,
    colors: { soil: [0.71, 0.45, 0.30], veg: [0.47, 0.50, 0.30], rock: [0.62, 0.36, 0.26] },
    blurb: 'Canyon country of the Colorado Plateau: hot dry summers, cold nights, rare but violent monsoon storms that send flash floods down bare slickrock.',
    tagline: 'Red rock, flash floods',
    // display palette (sRGB) used by the renderer
    palette: { rock: [0.70, 0.40, 0.25], rock2: [0.80, 0.62, 0.45], soil: [0.72, 0.50, 0.33], talus: [0.68, 0.48, 0.36], veg: [0.45, 0.45, 0.30], vegAmount: 0.10, sand: [0.86, 0.70, 0.52], banding: 0.6 },
    // trees drawn by the renderer: conifer share, autumn colour (0 gold, 1 red), pinyon-juniper share
    forest: { conifer: 0.35, autumn: 0, shrub: 0.9 },
    // prevailing wind (sim/wind.js): bearing it blows FROM, strength (1 = a windy desert), steadiness
    // (1 one direction .. 0 all around the compass), sand share of the plain soil
    wind: { from: 225, speed: 1.1, steady: 0.75, sandy: 0.6 },
  },
  'Colorado alpine': {
    tSea: 20, tAmp: 11, lapse: 6.5, pMean: 2.2, pSeas: 0.3, pPeakDay: 60, tPeakDay: 200, dtr: 15,
    orog: 0.5, ksat: 0.025, gwMax: 0.25, etMul: 1.0, baseElevation: 2900, wetFrac: 0.32, stormLen: 2,
    colors: { soil: [0.45, 0.38, 0.28], veg: [0.20, 0.36, 0.17], rock: [0.50, 0.48, 0.46] },
    blurb: 'High Rockies near treeline: long snowy winters, a quick spring melt and summer afternoon thunderstorms. Granite peaks, talus slopes.',
    tagline: 'Snowy peaks',
    // display palette (sRGB) used by the renderer
    palette: { rock: [0.47, 0.46, 0.45], rock2: [0.36, 0.35, 0.36], soil: [0.40, 0.34, 0.27], talus: [0.58, 0.56, 0.53], veg: [0.24, 0.30, 0.17], vegAmount: 0.35, sand: [0.56, 0.53, 0.48], banding: 0.15 },
    forest: { conifer: 0.5, autumn: 0, shrub: 0 },        // spruce-fir with golden aspen groves
    wind: { from: 270, speed: 1.0, steady: 0.8, sandy: 0.25 },   // strong westerlies over the divide
  },
  'Pacific NW wet': {
    tSea: 11, tAmp: 7, lapse: 6.0, pMean: 6.0, pSeas: 0.75, pPeakDay: 350, tPeakDay: 205, dtr: 8,
    orog: 0.8, ksat: 0.04, gwMax: 0.35, etMul: 0.8, baseElevation: 150, wetFrac: 0.55, stormLen: 3,
    colors: { soil: [0.32, 0.27, 0.20], veg: [0.12, 0.33, 0.13], rock: [0.38, 0.39, 0.38] },
    blurb: 'Cascade foothills near Puget Sound: mild, grey and very wet. Rain most of the winter, snow only up high, dark volcanic rock.',
    tagline: 'Rainy and mild',
    // display palette (sRGB) used by the renderer
    palette: { rock: [0.30, 0.30, 0.31], rock2: [0.24, 0.24, 0.26], soil: [0.28, 0.22, 0.16], talus: [0.42, 0.41, 0.40], veg: [0.14, 0.26, 0.12], vegAmount: 0.85, sand: [0.46, 0.43, 0.37], banding: 0.05 },
    forest: { conifer: 0.9, autumn: 0.7, shrub: 0 },      // Douglas fir and cedar, a few maples
    wind: { from: 225, speed: 0.5, steady: 0.6, sandy: 0.2 },
  },
  'Temperate': {
    tSea: 12, tAmp: 10, lapse: 6.5, pMean: 2.5, pSeas: 0.15, pPeakDay: 180, tPeakDay: 200, dtr: 10,
    orog: 0.4, ksat: 0.03, gwMax: 0.3, etMul: 1.0, baseElevation: 300, wetFrac: 0.38, stormLen: 2,
    colors: { soil: [0.42, 0.34, 0.24], veg: [0.27, 0.42, 0.18], rock: [0.48, 0.46, 0.43] },
    blurb: 'Rolling uplands like the Appalachians or central Europe: four distinct seasons, steady rain all year, a modest winter snowpack.',
    tagline: 'Four seasons',
    // display palette (sRGB) used by the renderer
    palette: { rock: [0.50, 0.47, 0.42], rock2: [0.42, 0.40, 0.37], soil: [0.36, 0.28, 0.20], talus: [0.55, 0.52, 0.47], veg: [0.25, 0.34, 0.16], vegAmount: 0.7, sand: [0.58, 0.53, 0.43], banding: 0.25 },
    forest: { conifer: 0.2, autumn: 1, shrub: 0 },        // oak-maple-beech, red and orange in October
    wind: { from: 260, speed: 0.7, steady: 0.5, sandy: 0.3 },
  },
  // Home climate of the Gulf Coastal Plain (sim/strata.js), like Baton Rouge or Houston: about 20 degC
  // mean, mild winters with rare frost, ~1.5 m of rain a year peaking in summer thunderstorms and
  // tropical storms, and high evaporation. Warm, wet ground is where salt and limestone dissolve fastest.
  'Gulf Coast humid': {
    tSea: 20.5, tAmp: 8.5, lapse: 6.5, pMean: 4.1, pSeas: 0.25, pPeakDay: 200, tPeakDay: 205, dtr: 9,
    orog: 0.3, ksat: 0.03, gwMax: 0.35, etMul: 1.3, baseElevation: 20, wetFrac: 0.40, stormLen: 1.5,
    colors: { soil: [0.40, 0.31, 0.21], veg: [0.20, 0.38, 0.16], rock: [0.62, 0.58, 0.50] },
    blurb: 'The Gulf Coastal Plain of Louisiana and east Texas: long hot, humid summers with afternoon thunderstorms and the odd tropical storm, mild winters with hardly any frost, and about 1.5 m of rain a year. Pine and oak forest, bayous.',
    tagline: 'Hot and wet',
    // display palette (sRGB) used by the renderer
    palette: { rock: [0.62, 0.58, 0.50], rock2: [0.54, 0.50, 0.43], soil: [0.40, 0.30, 0.20], talus: [0.58, 0.54, 0.46], veg: [0.20, 0.34, 0.15], vegAmount: 0.85, sand: [0.82, 0.76, 0.62], banding: 0.2 },
    forest: { conifer: 0.5, autumn: 0.4, shrub: 0 },      // loblolly pine with oak and sweetgum
    wind: { from: 160, speed: 0.6, steady: 0.5, sandy: 0.5 },    // onshore breeze off the Gulf
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
    // Day-to-day weather (ported from the Physicist build): a two-state Markov chain of wet and dry
    // spells, with wet-day fraction and mean storm length per preset. Wet days get 1/wetFrac times
    // the seasonal mean (times a random storm size), so the long-term mean equals the seasonal curve.
    this.wx = 1;
    this.wxDay = -1;
    this.wet = false;
    this.rng = 12345;
    // wind overrides from the panel (null = the preset's own wind)
    this.windFrom = null; this.windSpeed = null; this.windSteady = null;
  }
  rand() {
    // mulberry32
    let t = (this.rng = (this.rng + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  resetWeather(seed = 1) { this.rng = (seed * 2654435761) | 0; this.wxDay = -1; this.wet = false; this.wx = 1; }
  // Advance the wet/dry chain to the batch [day, day + D). Batches longer than 2 days see the mean.
  advanceWeather(day, D) {
    const p = this.preset;
    if (D > 2 || !p.wetFrac) { this.wx = 1; this.wxDay = Math.floor(day + D); return; }
    const target = Math.floor(day + D * 0.5);
    if (this.wxDay < 0 || target - this.wxDay > 30) this.wxDay = target - 30;   // spin up after a jump
    while (this.wxDay < target) {
      this.wxDay++;
      const pEnd = 1 / p.stormLen;                                   // wet -> dry
      const pStart = (p.wetFrac / (1 - p.wetFrac)) * pEnd;           // dry -> wet (stationary wet fraction)
      this.wet = this.wet ? this.rand() > pEnd : this.rand() < pStart;
      this.size = Math.min(5, -Math.log(1 - 0.999 * this.rand()));    // storm size, mean ~1
    }
    this.wx = this.wet ? this.size / p.wetFrac : 0;
  }
  get preset() { return PRESETS[this.presetName] || PRESETS['Colorado alpine']; }
  setPreset(name) { if (PRESETS[name]) { this.presetName = name; this.windFrom = this.windSpeed = this.windSteady = null; } }
  // prevailing wind: { from (bearing deg), speed, steady 0..1, sandy }
  windSettings() {
    const w = this.preset.wind;
    return { from: this.windFrom ?? w.from, speed: this.windSpeed ?? w.speed, steady: this.windSteady ?? w.steady, sandy: w.sandy };
  }
  triggerStorm(days = 3, mul = 12) { this.stormDaysLeft = days; this.stormMul = mul; }

  // Day-to-day weather multiplier. A forced "big storm" replaces the day's weather (wet or dry)
  // so it is always the advertised 12x the seasonal mean, never stacked on a natural storm.
  weatherMul() { return this.stormDaysLeft > 0 ? 1 : this.wx; }

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
      precipRate_mm_per_day: this.precipAt(dayOfYear) * this.stormFactor(D) * this.weatherMul(),
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
      tPeakDay: p.tPeakDay, dtr: p.dtr, stormMul: this.stormFactor(D) * this.weatherMul(), zRef: refElevation, orog: p.orog,
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
