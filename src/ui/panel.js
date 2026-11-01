// Side panel: climate, time (speed dial), terrain, view/overlays, live stats, benchmark.
import { PRESET_NAMES } from '../sim/climate.js';
import { SCENARIOS } from '../terrain.js';
import { OVERLAYS } from '../render/renderer.js';

const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
};

// speed dial: slider 0..1000 -> 1 day/s .. 1000 yr/s (log)
const SMIN = 1, SMAX = 365000;
export const sliderToSpeed = (v) => SMIN * Math.pow(SMAX / SMIN, v / 1000);
export const speedToSlider = (s) => (1000 * Math.log(Math.max(SMIN, s) / SMIN)) / Math.log(SMAX / SMIN);
export function fmtSpeed(s) {
  if (s < 30) return `${s.toFixed(s < 10 ? 1 : 0)} days/s`;
  if (s < 365) return `${(s / 30.4).toFixed(1)} months/s`;
  const y = s / 365;
  return `${y < 10 ? y.toFixed(1) : Math.round(y)} years/s`;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MDAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export function fmtDate(day) {
  const y = Math.floor(day / 365);
  let d = Math.floor(day - y * 365), m = 0;
  while (m < 11 && d >= MDAYS[m]) { d -= MDAYS[m]; m++; }
  return { year: y, text: `${MONTHS[m]} ${d + 1}`, season: ['Winter', 'Winter', 'Spring', 'Spring', 'Spring', 'Summer', 'Summer', 'Summer', 'Autumn', 'Autumn', 'Autumn', 'Winter'][m] };
}
const fmtVol = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(2) + ' km³';
  if (a >= 1e6) return (v / 1e6).toFixed(2) + ' Mm³';
  if (a >= 1e3) return (v / 1e3).toFixed(1) + ' k m³';
  return v.toFixed(0) + ' m³';
};

const LEGENDS = {
  water: ['Water depth', 'linear-gradient(90deg,#bfe6ff,#1a80f2,#0d0d73)', '0', '2 m+'],
  sediment: ['Sediment in transport (bed-equivalent)', 'linear-gradient(90deg,#fff299,#f28c1a,#80260d)', '0', '0.5 m+'],
  snow: ['Snow water equivalent', 'linear-gradient(90deg,#ccf2ff,#6699ff,#801ab3)', '0', '0.5 m+'],
  frost: ['Frost depth', 'linear-gradient(90deg,#b3ffff,#33b3e6,#1a3399)', '0', '1 m+'],
  change: ['Elevation change since start', 'linear-gradient(90deg,#cc1a0d,#f7f7f2,#0d4dd9)', 'eroded -5 m', '+5 m deposited'],
};

export class Panel {
  constructor(root, app) {
    this.app = app;
    const sim = app.sim;
    const r = (label, input, valEl) => el('div', { class: 'row' }, el('label', {}, label), input, ...(valEl ? [valEl] : []));
    const slider = (min, max, step, value, oninput) => { const s = el('input', { type: 'range', min, max, step, value }); s.addEventListener('input', () => oninput(+s.value)); return s; };
    const sel = (opts, value, onchange) => { const s = el('select', {}); for (const o of opts) s.append(el('option', { value: o }, o)); s.value = value; s.addEventListener('change', () => onchange(s.value)); return s; };

    // ---- time ----
    this.playBtn = el('button', { class: 'big primary', onclick: () => { sim.paused ? app.play() : app.pause(); this.sync(); } }, 'Pause');
    this.speedLabel = el('span', { class: 'speed' });
    this.speedSlider = slider(0, 1000, 1, speedToSlider(sim.speed), (v) => { app.setSpeed(sliderToSpeed(v)); this.sync(false); });
    const chips = el('div', { class: 'chips' });
    this.chipBtns = [['1 day/s', 1], ['1 wk/s', 7], ['1 mo/s', 30.4], ['1 yr/s', 365], ['10 yr/s', 3650], ['100 yr/s', 36500], ['1000 yr/s', 365000]].map(([t, v]) => {
      const b = el('button', { onclick: () => { app.setSpeed(v); this.sync(); } }, t); b.dataset.v = v; chips.append(b); return b;
    });
    this.timeNote = el('div', { class: 'note' });

    // ---- climate ----
    const c = sim.climate;
    this.presetSel = sel(PRESET_NAMES, c.presetName, (v) => { c.setPreset(v); sim.datum = c.preset.baseElevation; this.sync(); });
    this.tempVal = el('span', { class: 'val' }); this.precipVal = el('span', { class: 'val' }); this.seasVal = el('span', { class: 'val' }); this.eroVal = el('span', { class: 'val' });
    this.tempS = slider(-10, 10, 0.5, c.tempOffset, (v) => { c.tempOffset = v; this.sync(false); });
    this.precipS = slider(0, 3, 0.05, c.precipMul, (v) => { c.precipMul = v; this.sync(false); });
    this.seasS = slider(0, 2, 0.05, c.seasonality, (v) => { c.seasonality = v; this.sync(false); });
    this.eroS = slider(-1, 1, 0.01, Math.log10(sim.erosionStrength), (v) => { sim.erosionStrength = Math.pow(10, v); this.sync(false); });
    this.stormBtn = el('button', { onclick: () => { c.triggerStorm(3, 12); this.sync(false); } }, 'Big storm (3 days)');
    this.weather = el('div', { class: 'note' });

    // ---- terrain ----
    this.scenSel = sel(SCENARIOS, 'random', () => {});
    this.seedIn = el('input', { type: 'number', value: 1, min: 0, step: 1 });
    this.sizeSel = sel(['256', '512', '1024'], '512', () => {});
    this.cellSel = sel(['5', '10', '20', '30'], '10', () => {});
    this.rugVal = el('span', { class: 'val' }); this.relVal = el('span', { class: 'val' });
    this.rugS = slider(0, 1, 0.01, 0.5, (v) => { this.rugVal.textContent = v.toFixed(2); });
    this.relS = slider(0.3, 2, 0.05, 1, (v) => { this.relVal.textContent = v.toFixed(2) + '×'; });
    const gen = () => app.load(this.scenSel.value, { size: +this.sizeSel.value, cellSize: +this.cellSel.value, seed: +this.seedIn.value, ruggedness: +this.rugS.value, relief: +this.relS.value });
    const genBtn = el('button', { class: 'primary', onclick: gen }, 'Generate');
    const rndBtn = el('button', { onclick: () => { this.seedIn.value = Math.floor(Math.random() * 99999); this.scenSel.value = 'random'; gen(); } }, 'New random');
    const resetBtn = el('button', { onclick: gen }, 'Restart');

    // ---- view ----
    const ovChips = el('div', { class: 'chips' });
    this.ovBtns = OVERLAYS.map((o) => { const b = el('button', { onclick: () => { app.renderer.overlay = o; this.sync(); } }, o); b.dataset.o = o; ovChips.append(b); return b; });
    this.exVal = el('span', { class: 'val' });
    this.exS = slider(1, 4, 0.1, app.renderer.exaggeration, (v) => { app.renderer.exaggeration = v; this.sync(false); });
    const wChk = el('input', { type: 'checkbox' }); wChk.checked = true; wChk.addEventListener('change', () => { app.renderer.showWater = wChk.checked; });

    // ---- stats ----
    this.statsTbl = el('table', { class: 'stats' });
    this.benchOut = el('div', { class: 'note' });
    const benchBtn = el('button', { onclick: async () => { this.benchOut.textContent = 'Benchmarking (about 20 s)...'; const r = await app.bench(); this.benchOut.innerHTML = Object.entries(r).map(([n, v]) => `${n}²: ${v.stepsPerSec.toFixed(0)} sub-steps/s, ${v.fps.toFixed(0)} fps @ ${v.substepsPerFrame} sub-steps/frame`).join('<br>'); } }, 'Run benchmark');

    root.append(
      el('h1', {}, 'Landscape Simulator'),
      el('div', { class: 'row' }, this.playBtn, this.speedLabel),
      el('div', { class: 'row' }, this.speedSlider), chips, this.timeNote,
      el('h2', {}, 'Climate'),
      r('Preset', this.presetSel),
      r('Temperature', this.tempS, this.tempVal), r('Precipitation', this.precipS, this.precipVal),
      r('Seasonality', this.seasS, this.seasVal), r('Erosion rate', this.eroS, this.eroVal),
      el('div', { class: 'row' }, this.stormBtn), this.weather,
      el('h2', {}, 'Terrain'),
      r('Scenario', this.scenSel), r('Seed', this.seedIn), r('Ruggedness', this.rugS, this.rugVal), r('Relief', this.relS, this.relVal),
      r('Grid size', this.sizeSel), r('Cell size (m)', this.cellSel),
      el('div', { class: 'row' }, genBtn, rndBtn, resetBtn),
      el('h2', {}, 'View'),
      ovChips,
      r('Vertical ×', this.exS, this.exVal),
      el('div', { class: 'row' }, el('label', {}, 'Show water'), wChk),
      el('div', { class: 'note' }, 'Drag to rotate · right-drag or shift-drag to pan · wheel to zoom'),
      el('h2', {}, 'Engine'), this.statsTbl,
      el('div', { class: 'row' }, benchBtn), this.benchOut,
    );
    this.rugVal.textContent = '0.50'; this.relVal.textContent = '1.00×';
    this.sync();
  }

  syncTerrain(opts) {
    this.scenSel.value = opts.scenario; this.seedIn.value = opts.seed; this.sizeSel.value = String(opts.N); this.cellSel.value = String(opts.cellSize);
  }

  sync(sliders = true) {
    const { sim, renderer } = this.app;
    const c = sim.climate;
    this.playBtn.textContent = sim.paused ? 'Play' : 'Pause';
    this.speedLabel.textContent = fmtSpeed(sim.speed);
    if (sliders) {
      this.speedSlider.value = speedToSlider(sim.speed);
      this.presetSel.value = c.presetName;
      this.tempS.value = c.tempOffset; this.precipS.value = c.precipMul; this.seasS.value = c.seasonality;
      this.eroS.value = Math.log10(sim.erosionStrength); this.exS.value = renderer.exaggeration;
    }
    for (const b of this.chipBtns) b.classList.toggle('on', Math.abs(Math.log(+b.dataset.v / sim.speed)) < 0.05);
    for (const b of this.ovBtns) b.classList.toggle('on', b.dataset.o === renderer.overlay);
    this.tempVal.textContent = (c.tempOffset >= 0 ? '+' : '') + c.tempOffset.toFixed(1) + ' °C';
    this.precipVal.textContent = c.precipMul.toFixed(2) + '×';
    this.seasVal.textContent = c.seasonality.toFixed(2) + '×';
    this.eroVal.textContent = sim.erosionStrength.toFixed(2) + '×';
    this.exVal.textContent = renderer.exaggeration.toFixed(1) + '×';
    const L = LEGENDS[renderer.overlay];
    const leg = document.getElementById('legend');
    leg.innerHTML = L ? `<div>${L[0]}</div><div class="bar" style="background:${L[1]}"></div><div class="ends"><span>${L[2]}</span><span>${L[3]}</span></div>` : '';
  }

  // called ~4x per second
  update(info) {
    const { sim } = this.app;
    const d = fmtDate(sim.day);
    const hud = document.getElementById('hud');
    const strobe = sim.strobe && !sim.paused;
    hud.innerHTML = `<div class="date">Year ${d.year.toLocaleString()} · ${strobe ? 'seasons sampled' : d.text}</div>`
      + `<div class="sub">${strobe ? '' : d.season + ' · '}${sim.climate.presetName} · ${sim.paused ? 'paused' : fmtSpeed(sim.speed)}${sim.running ? ' · fast-forward' : ''}</div>`
      + (sim.climate.stormDaysLeft > 0 ? '<div class="tag">Storm!</div>' : '');
    const lc = sim.lastClimate;
    if (lc) {
      const tm = sim.climate.airTempAt(lc.dayOfYear, sim.datum + (sim.terrainRange?.mean ?? 0));
      this.weather.textContent = `Now at mean elevation (${Math.round(sim.datum + (sim.terrainRange?.mean ?? 0))} m): ${tm.toFixed(1)} °C, ${lc.precipRate_mm_per_day.toFixed(1)} mm/day ${tm < 0.5 ? 'snow' : 'rain'}`;
    }
    const p = sim.lastPlan || {};
    this.timeNote.textContent = p.morph > 1.01
      ? `Water routed at ${p.aW?.toFixed(0)}× real intensity; landscape change accelerated ${p.morph < 1e4 ? p.morph.toFixed(0) : p.morph.toExponential(1)}× (morphological factor).`
      : 'Real-time hydrology (no morphological acceleration).';
    const s = info.stats;
    const rows = [
      ['Frame rate', `${info.fps.toFixed(0)} fps`],
      ['Graphics card', info.adapter || '?'],
      ['GPU time: sim / render', info.timed ? `${info.simMs.toFixed(1)} / ${info.renderMs.toFixed(1)} ms` : `${info.gpuMs.toFixed(1)} ms (approx)`],
      ['Hydraulic sub-steps / frame', `${sim.nSub}`],
      ['Hydraulic dt', `${(p.dtH || 0).toFixed(2)} s`],
      ['Grid', `${sim.N}² × ${sim.world?.cellSize} m`],
    ];
    if (s) {
      rows.push(
        ['Surface water', fmtVol(s.totalWater_m3)], ['Snow (SWE)', fmtVol(s.totalSnowSWE_m3)], ['Groundwater', fmtVol(s.totalGroundwater_m3)],
        ['Sediment moving', fmtVol(s.totalSediment_m3)], ['Total precipitation', fmtVol(s.cumPrecip_m3)],
        ['Outflow / evaporation', `${fmtVol(s.cumOutflow_m3)} / ${fmtVol(s.cumEvapLoss_m3)}`],
        ['Water balance error', `<span class="${Math.abs(s.balanceErrorPct) < 0.5 ? 'ok' : 'warn'}">${s.balanceErrorPct.toFixed(4)} %</span>`],
        ['Elevation range', `${Math.round(s.minHeight)} – ${Math.round(s.maxHeight)} m`],
        ['Deepest water', `${s.maxWaterDepth.toFixed(2)} m`],
        ['NaN check', s.hasNaN ? '<span class="warn">NaN!</span>' : '<span class="ok">clean</span>'],
      );
    }
    this.statsTbl.innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  }
}
