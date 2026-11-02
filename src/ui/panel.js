// Side panel, date card, time bar and tooltips (layout from the Artist build, wired to the engine).
import { PRESETS } from '../sim/climate.js';
import { OVERLAYS, showLegend } from './legend.js';

const $ = (id) => document.getElementById(id);
const SPEED_MAX = 365000;
const WEATHER_VISIBLE_SPEED = 36;

export function speedToSlider(s) { return Math.round((Math.log10(Math.max(1, s)) / Math.log10(SPEED_MAX)) * 1000); }
export function sliderToSpeed(v) { return Math.pow(10, (v / 1000) * Math.log10(SPEED_MAX)); }

export function speedText(s) {
  if (s < 1.5) return '1 day / second';
  if (s < 30) return `${Math.round(s)} days / second`;
  if (s < 365) { const m = s / 30.4; return `${m < 1.5 ? 1 : Math.round(m)} month${m < 1.5 ? '' : 's'} / second`; }
  const y = s / 365;
  if (y < 1.5) return '1 year / second';
  if (y < 20) return `${Math.round(y)} years / second`;
  return `${(Math.round(y / 10) * 10).toLocaleString()} years / second`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

export function dateLabel(dayOfYear) {
  const d = Math.floor(((dayOfYear % 365) + 365) % 365);
  let m = 0;
  while (d >= MONTH_START[m + 1]) m++;
  return { month: MONTHS[m], monthIndex: m, day: d - MONTH_START[m] + 1 };
}

export function seasonOf(dayOfYear) {
  const { monthIndex: m } = dateLabel(dayOfYear);
  const name = m === 11 || m <= 1 ? 'Winter' : m <= 4 ? 'Spring' : m <= 7 ? 'Summer' : 'Autumn';
  const phaseMonth = m === 11 ? 0 : m <= 1 ? m + 1 : (m - 2) % 3;
  return { name, label: `${['Early', 'Mid', 'Late'][phaseMonth]} ${name.toLowerCase()}` };
}

function fmtVol(m3) {
  const a = Math.abs(m3);
  if (a >= 1e9) return `${(m3 / 1e9).toFixed(2)} billion m³`;
  if (a >= 1e6) return `${(m3 / 1e6).toFixed(2)} million m³`;
  if (a >= 1e3) return `${(m3 / 1e3).toFixed(1)} thousand m³`;
  return `${m3.toFixed(0)} m³`;
}

function presetSwatch(p) {
  const c = (a) => `rgb(${a.map((v) => Math.round(v * 255)).join(',')})`;
  return `linear-gradient(90deg, ${c(p.palette.rock)}, ${c(p.palette.talus)}, ${c(p.palette.soil)}, ${c(p.palette.veg)})`;
}

export class Panel {
  constructor(app) {
    this.app = app;
    this.buildPresets();
    this.buildOverlays();
    this.bindControls();
    this.bindTooltips();
    this.initialSolid = null;
    this.syncPreset();
    this.sync();
  }

  buildPresets() {
    const wrap = $('presets');
    wrap.innerHTML = '';
    for (const [name, p] of Object.entries(PRESETS)) {
      const b = document.createElement('button');
      b.className = 'preset';
      b.dataset.preset = name;
      b.innerHTML = `<span class="sw" style="background:${presetSwatch(p)}"></span><span>${name}</span><small>${p.tagline || ''}</small>`;
      b.addEventListener('click', () => this.setPreset(name));
      wrap.appendChild(b);
    }
  }

  setPreset(name) {
    const sim = this.app.sim;
    sim.climate.setPreset(name);
    sim.datum = sim.climate.preset.baseElevation;
    this.syncPreset();
  }

  syncPreset() {
    const name = this.app.sim.climate.presetName;
    for (const b of document.querySelectorAll('.preset')) b.classList.toggle('active', b.dataset.preset === name);
    $('preset-blurb').textContent = PRESETS[name].blurb;
  }

  buildOverlays() {
    const wrap = $('overlays');
    wrap.innerHTML = '';
    for (const o of OVERLAYS) {
      const d = document.createElement('div');
      d.className = 'overlay-opt' + (o.id === 0 ? ' active' : '');
      d.dataset.id = o.id;
      d.innerHTML = `<span class="dot" style="background:${o.dot}"></span><span>${o.name}</span><small>${o.desc}</small>`;
      d.addEventListener('click', () => this.setOverlay(o.id));
      wrap.appendChild(d);
    }
  }

  /** Accepts the shader mode number or the engine's overlay name ('water', 'change', ...). */
  setOverlay(id) {
    const r = this.app.renderer;
    r.overlay = id;
    for (const d of document.querySelectorAll('.overlay-opt')) d.classList.toggle('active', +d.dataset.id === r.mode);
    showLegend(r.mode);
  }

  bindControls() {
    const app = this.app;
    const sim = app.sim;
    const c = sim.climate;
    const out = (id, text) => { $(id).textContent = text; };
    const temp = () => {
      const v = +$('temp').value;
      c.tempOffset = v;
      out('temp-out', v === 0 ? 'normal' : `${v > 0 ? '+' : ''}${v} °C ${v > 0 ? 'warmer' : 'colder'}`);
    };
    const precip = () => {
      const k = Math.pow(2, +$('precip').value);
      c.precipMul = k;
      out('precip-out', Math.abs(k - 1) < 0.04 ? 'normal' : `${k.toFixed(2)}x`);
    };
    const seas = () => {
      const v = +$('seas').value;
      c.seasonality = v;
      out('seas-out', Math.abs(v - 1) < 0.03 ? 'normal' : v < 0.05 ? 'none' : `${v.toFixed(2)}x`);
    };
    const ero = () => {
      const k = Math.pow(2, +$('erosion').value);
      sim.erosionStrength = k;
      out('erosion-out', Math.abs(k - 1) < 0.04 ? 'normal' : `${k.toFixed(2)}x`);
    };
    for (const [id, fn] of [['temp', temp], ['precip', precip], ['seas', seas], ['erosion', ero]]) {
      $(id).addEventListener('input', fn);
      fn();
    }
    $('storm').addEventListener('click', () => { c.triggerStorm(3, 12); });
    $('rugged').addEventListener('input', () => out('rugged-out', (+$('rugged').value).toFixed(2)));
    $('vex').addEventListener('input', () => {
      app.renderer.exaggeration = +$('vex').value;
      out('vex-out', `${(+$('vex').value).toFixed(2)}x`);
    });
    $('contours').addEventListener('change', () => { app.renderer.contours = $('contours').checked; });
    $('spin').addEventListener('change', () => { app.renderer.camera.autoRotate = $('spin').checked; });
    $('trees').addEventListener('change', () => { app.renderer.showTrees = $('trees').checked; });
    $('dice').addEventListener('click', () => {
      $('seed').value = 1 + Math.floor(Math.random() * 99999);
      $('scenario').value = 'random';
      this.generate();
    });
    $('generate').addEventListener('click', () => this.generate());
    $('speed').addEventListener('input', () => app.setSpeed(sliderToSpeed(+$('speed').value)));
    for (const t of document.querySelectorAll('.ticks span')) {
      t.addEventListener('click', () => app.setSpeed(+t.dataset.speed));
    }
    $('play').addEventListener('click', () => (sim.paused ? app.play() : app.pause()));
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !['INPUT', 'SELECT'].includes(document.activeElement?.tagName)) {
        e.preventDefault();
        sim.paused ? app.play() : app.pause();
      }
    });
    $('collapse').addEventListener('click', () => this.collapse(true));
    $('expand').addEventListener('click', () => this.collapse(false));
  }

  collapse(on) {
    $('panel').classList.toggle('hidden', on);
    $('expand').classList.toggle('hidden', !on);
    document.body.classList.toggle('collapsed', on);
  }

  generate() {
    this.app.load($('scenario').value, {
      size: +$('size').value,
      seed: +$('seed').value,
      ruggedness: +$('rugged').value,
      preset: this.app.sim.climate.presetName,
    });
  }

  /** Reflect the engine's terrain settings into the controls (after a URL/API load). */
  syncTerrain(res) {
    const sim = this.app.sim;
    $('scenario').value = res.scenario;
    $('size').value = String(res.N);
    $('seed').value = res.seed;
    $('rugged').value = sim.ruggedness;
    $('rugged-out').textContent = (+sim.ruggedness).toFixed(2);
    this.initialSolid = null;
  }

  /** Reflect speed, play state and climate preset. */
  sync() {
    const sim = this.app.sim;
    $('speed').value = speedToSlider(sim.speed);
    $('speed-text').textContent = speedText(sim.speed);
    $('icon-pause').style.display = sim.paused ? 'none' : '';
    $('icon-play').style.display = sim.paused ? '' : 'none';
    this.syncPreset();
  }

  bindTooltips() {
    const tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.className = 'hidden';
    document.body.appendChild(tip);
    document.addEventListener('mouseover', (e) => {
      const t = e.target.closest?.('.tip');
      if (!t) return;
      tip.textContent = t.dataset.tip;
      tip.classList.remove('hidden');
      const r = t.getBoundingClientRect();
      const w = 260;
      let x = r.right + 8;
      if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 8);
      tip.style.left = `${x}px`;
      tip.style.top = `${Math.min(window.innerHeight - 140, Math.max(8, r.top - 10))}px`;
    });
    document.addEventListener('mouseout', (e) => {
      if (e.target.closest?.('.tip')) tip.classList.add('hidden');
    });
  }

  /** Date/weather card; called every frame. */
  updateHud() {
    const sim = this.app.sim;
    const c = sim.lastClimate;
    if (!c) return;
    const cl = sim.climate;
    const year = Math.floor(sim.day / 365) + 1;
    const dl = dateLabel(c.dayOfYear);
    const fast = !sim.paused && sim.speed > WEATHER_VISIBLE_SPEED;
    $('hud-date').textContent = fast ? `Year ${year.toLocaleString()}` : `Year ${year.toLocaleString()} · ${dl.day} ${dl.month}`;
    const season = seasonOf(c.dayOfYear);
    const sEl = $('hud-season');
    sEl.textContent = fast ? `${season.name} (${dl.month})` : season.label;
    sEl.className = 'chip ' + season.name.toLowerCase();
    const tr = sim.terrainRange || { min: 0, max: 0 };
    const zLow = sim.datum + tr.min, zHigh = sim.datum + tr.max;
    const tLow = cl.airTempAt(c.dayOfYear, zLow), tHigh = cl.airTempAt(c.dayOfYear, zHigh);
    const rate = c.precipRate_mm_per_day;
    let weather;
    const ev = sim.events;
    if (ev.floods.length) weather = 'Flood wave coming down!';
    else if (ev.storms.length) weather = 'Cloudburst on the map';
    else if (ev.drought) weather = `Drought (${Math.max(0.1, ev.drought.left / 365).toFixed(1)} years left)`;
    else if (ev.fireWeather > 0.05) weather = 'Wildfire burning';
    else if (cl.stormDaysLeft > 0) weather = 'Big storm!';
    else if (fast) weather = 'Weather averaged';
    else if (rate < 0.3) weather = season.name === 'Summer' && tLow > 22 ? 'Hot and dry' : 'Clear';
    else {
      const heavy = rate > 15;
      if (tLow < 0.5) weather = heavy ? 'Heavy snow' : 'Snowing';
      else if (tHigh < 0.5) weather = heavy ? 'Storm: snow up high, rain below' : 'Snow up high, rain below';
      else weather = heavy ? (season.name === 'Summer' ? 'Thunderstorm' : 'Heavy rain') : 'Raining';
    }
    $('hud-weather').textContent = weather;
    const f = (t) => `${t >= 0 ? '' : '−'}${Math.abs(Math.round(t))} °C`;
    $('hud-temps').textContent = `Valley ${f(tLow)} · Peaks ${f(tHigh)} · ${Math.round(zLow).toLocaleString()}–${Math.round(zHigh).toLocaleString()} m above sea level`;
    $('hud-lapse').textContent = sim.running ? 'Fast-forwarding...'
      : fast ? `Time-lapse: each second is about ${speedText(sim.speed).replace(' / second', '')}; seasons shown at about 1 year per 4 s` : '';
  }

  /** Running account; called a few times per second. */
  update(info) {
    const t = info.stats;
    if (!t) return;
    const solid = t.totalSoil_m3 + t.totalBedrock_m3 + t.totalSediment_m3;
    if (this.initialSolid === null || t.day === 0) this.initialSolid = solid;
    const lost = this.initialSolid - solid;
    const err = Math.abs(t.balanceErrorPct);
    const ok = !t.hasNaN && err < 0.5;
    const rows = [
      ['Water in streams & lakes', fmtVol(t.totalWater_m3)],
      ['Water stored as snow', fmtVol(t.totalSnowSWE_m3)],
      ['Water soaked into the ground', fmtVol(t.totalGroundwater_m3)],
      ['Rain & snow that fell', fmtVol(t.cumPrecip_m3)],
      ['Flowed off the map', fmtVol(t.cumOutflow_m3)],
      ['Evaporated or used by plants', fmtVol(t.cumEvapLoss_m3)],
      ['Water books balance', `<span class="${ok ? 'good' : 'bad'}">${t.hasNaN ? 'ERROR (NaN)' : err < 0.001 ? 'yes, exact' : `off by ${err.toFixed(3)}%`}</span>`],
      'sep',
      ['Ground covered by plants', `${Math.round(100 * (t.vegCoveredFrac ?? 0))}%`],
      ['Recently burned', `${(100 * (t.burnedFrac ?? 0)).toFixed(1)}%`],
      'sep',
      ['Rock & soil carried away', fmtVol(Math.max(0, lost))],
      ['Highest point', `${Math.round(t.maxHeight).toLocaleString()} m`],
      ['Lowest point', `${Math.round(t.minHeight).toLocaleString()} m`],
      'sep',
      ['Frames per second', `${Math.round(info.fps)}`],
      ['Graphics card', info.adapter || '?'],
    ];
    $('stats').innerHTML = rows.map((r) => (r === 'sep' ? '<div class="sep"></div>' : `<span class="k">${r[0]}</span><span class="v">${r[1]}</span>`)).join('');
  }
}
