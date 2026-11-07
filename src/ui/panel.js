// Side panel, date card, time bar and tooltips (layout from the Artist build, wired to the engine).
import { PRESETS } from '../sim/climate.js';
import { PROVINCES, resolveProvince } from '../sim/strata.js';
import { OVERLAYS, showLegend } from './legend.js';

const $ = (id) => document.getElementById(id);
const SPEED_MAX = 365000;
const SPEED_MIN = 0.01;   // ~15 minutes per second: slow motion for floods
const WEATHER_VISIBLE_SPEED = 36;

// controls where the Space bar does something of its own (a range slider does not, so Space still
// plays/pauses after you drag one)
const usesSpace = (el) => !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON'
  || el.isContentEditable || (el.tagName === 'INPUT' && el.type !== 'range')
  || ['button', 'radio'].includes(el.getAttribute?.('role')));

const LMIN = Math.log10(SPEED_MIN), LMAX = Math.log10(SPEED_MAX);
export function speedToSlider(s) { return Math.round(((Math.log10(Math.max(SPEED_MIN, s)) - LMIN) / (LMAX - LMIN)) * 1000); }
export function sliderToSpeed(v) { return Math.pow(10, LMIN + (v / 1000) * (LMAX - LMIN)); }

export function speedText(s) {
  if (s < 0.04) return `${Math.max(5, Math.round((s * 1440) / 5) * 5)} minutes / second (slow motion)`;
  if (s < 0.8) { const h = Math.round(s * 24); return `${h} hour${h === 1 ? '' : 's'} / second (slow motion)`; }
  if (s < 1.5) return '1 day / second';
  if (s < 30) return `${Math.round(s)} days / second`;
  if (s < 365) { const m = s / 30.4; return `${m < 1.5 ? 1 : Math.round(m)} month${m < 1.5 ? '' : 's'} / second`; }
  const y = s / 365;
  if (y < 1.5) return '1 year / second';
  if (y < 20) return `${Math.round(y)} years / second`;
  return `${(Math.round(y / 10) * 10).toLocaleString()} years / second`;
}

function fmtSecs(s) {
  s = Math.max(1, Math.round(s));
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60), r = s % 60;
  if (s < 3600) return r && m < 10 ? `${m} min ${r} s` : `${Math.round(s / 60)} min`;
  const h = s / 3600;
  if (h < 48) return `${Math.floor(h)} h ${Math.round((s % 3600) / 60)} min`;
  return `${Math.round(h / 24).toLocaleString()} days`;
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
    this.bindDropdowns();
    this.bindTimelapse();
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
    this.syncWind();
  }

  /** Reflect the wind settings (the preset's own wind unless changed) into the wind controls. */
  syncWind() {
    const sim = this.app.sim, w = sim.climate.windSettings();
    $('wind-on').checked = sim.windOn;
    $('wind-section').classList.toggle('wind-off', !sim.windOn);
    $('wind-arrow').style.transform = `rotate(${w.from}deg)`;
    const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const from = names[Math.round(w.from / 22.5) % 16];
    $('wind-from').textContent = `Wind from the ${from}`;
    const dial = $('wind-dial');
    dial.setAttribute('aria-valuenow', String(Math.round(w.from)));
    dial.setAttribute('aria-valuetext', `from the ${from}`);
    dial.tabIndex = sim.windOn ? 0 : -1;
    $('wind-speed').value = w.speed;
    $('wind-speed-out').textContent = w.speed < 0.05 ? 'calm' : w.speed < 0.3 ? 'very light' : w.speed < 0.8 ? 'light'
      : w.speed < 1.3 ? 'moderate' : w.speed < 1.7 ? 'strong' : 'gale';
    $('wind-steady').value = w.steady;
    $('wind-steady-out').textContent = w.steady >= 0.7 ? 'steady' : w.steady >= 0.35 ? 'two seasons' : 'shifting';
    $('wind-dunes').textContent = w.speed < 0.6 ? 'Too gentle to move sand; it still drifts snow.'
      : w.steady >= 0.7 ? 'Builds crescent dunes and ridges across the wind.'
      : w.steady >= 0.35 ? 'Builds long straight dunes along the wind.' : 'Piles sand into star dunes.';
  }

  buildOverlays() {
    const wrap = $('overlays');
    wrap.innerHTML = '';
    wrap.setAttribute('role', 'radiogroup');
    wrap.setAttribute('aria-label', 'View');
    for (const o of OVERLAYS) {
      const d = document.createElement('div');
      d.className = 'overlay-opt' + (o.id === 0 ? ' active' : '');
      d.dataset.id = o.id;
      d.tabIndex = 0;
      d.setAttribute('role', 'radio');
      d.setAttribute('aria-checked', String(o.id === 0));
      d.innerHTML = `<span class="dot" style="background:${o.dot}"></span><span>${o.name}</span><small>${o.desc}</small>`;
      d.addEventListener('click', () => this.setOverlay(o.id));
      d.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.setOverlay(o.id); } });
      wrap.appendChild(d);
    }
    $('show-me-current').textContent = `: ${OVERLAYS[0].name}`;
  }

  /** Accepts the shader mode number or the engine's overlay name ('water', 'change', ...). */
  setOverlay(id) {
    const r = this.app.renderer;
    r.overlay = id;
    for (const d of document.querySelectorAll('.overlay-opt')) {
      const on = +d.dataset.id === r.mode;
      d.classList.toggle('active', on);
      d.setAttribute('aria-checked', String(on));
    }
    // the heading says which view is on while the menu is closed
    const cur = OVERLAYS.find((o) => o.id === r.mode);
    $('show-me-current').textContent = cur ? `: ${cur.name}` : '';
    showLegend(r.mode);
    // sediment beds: add live numbers to the legend note while that view is open
    clearInterval(this.bedsTimer);
    if (r.mode === 8) {
      const base = document.getElementById('legend-note').textContent;
      const upd = async () => {
        const st = await window.sim?.depositPreview?.().catch(() => null);
        if (!st || r.mode !== 8) return;
        document.getElementById('legend-note').textContent = st.maxThickness_m < 0.01 ? `${base} (Nothing laid down yet.)`
          : `${base} Now: up to ${st.maxThickness_m.toFixed(st.maxThickness_m < 10 ? 1 : 0)} m thick and ${st.maxBeds} beds deep, covering ${(100 * st.coveredFrac).toFixed(0)}% of the map.`;
      };
      upd();
      this.bedsTimer = setInterval(upd, 3000);
    }
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
    $('storm').addEventListener('click', () => {
      c.triggerStorm(3, 12);
      app.brushTool?.toast('storm', 'Big storm!', 'Three days of very heavy rain or snow over the whole map, about twelve times the usual amount. Watch the streams flood, carry mud and cut into their beds.' + (sim.paused ? ` Press ${app.tl ? 'Resume' : 'Start'} to let it fall.` : ''));
    });
    $('rugged').addEventListener('input', () => out('rugged-out', (+$('rugged').value).toFixed(2)));
    // the landscape settings wait for "Make this landscape"; the button says when they have changed
    const pending = () => $('generate').classList.add('pending');
    for (const id of ['scenario', 'size', 'seed', 'rugged', 'province', 'old-volcanoes']) $(id).addEventListener('change', pending);
    $('scenario').addEventListener('change', () => this.syncRugged());
    this.syncRugged();
    $('vex').addEventListener('input', () => {
      app.renderer.exaggeration = +$('vex').value;
      out('vex-out', `${(+$('vex').value).toFixed(2)}x`);
    });
    $('contours').addEventListener('change', () => { app.renderer.contours = $('contours').checked; });
    $('spin').addEventListener('change', () => { app.renderer.camera.autoRotate = $('spin').checked; });
    app.renderer.camera.onAutoRotateChange = (on) => { $('spin').checked = on; };
    $('trees').addEventListener('change', () => { app.renderer.showTrees = $('trees').checked; });
    $('strata').addEventListener('change', () => { app.sim.strata = $('strata').checked; });
    $('glaciers').addEventListener('change', () => { app.sim.glaciers = $('glaciers').checked; });
    $('old-volcanoes').addEventListener('change', () => { app.sim.oldVolcanoes = $('old-volcanoes').checked; });
    // the browser may restore ticked boxes and slider positions after a reload: the engine follows them
    app.sim.strata = $('strata').checked; app.sim.glaciers = $('glaciers').checked;
    app.sim.oldVolcanoes = $('old-volcanoes').checked;
    app.renderer.contours = $('contours').checked; app.renderer.showTrees = $('trees').checked;
    app.renderer.camera.autoRotate = $('spin').checked;
    app.renderer.exaggeration = +$('vex').value; out('vex-out', `${(+$('vex').value).toFixed(2)}x`);
    // wind: on/off, a compass dial for where it blows from, strength and steadiness
    $('wind-on').addEventListener('change', () => { app.sim.windOn = $('wind-on').checked; this.syncWind(); });
    $('wind-speed').addEventListener('input', () => { c.windSpeed = +$('wind-speed').value; this.syncWind(); });
    $('wind-steady').addEventListener('input', () => { c.windSteady = +$('wind-steady').value; this.syncWind(); });
    const dial = $('wind-dial');
    const setFrom = (e) => {
      const r = dial.getBoundingClientRect();
      const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
      if (dx * dx + dy * dy < 4) return;
      // the arrow points where the wind blows TO; the wind comes from the opposite side
      const to = (Math.atan2(dx, -dy) * 180) / Math.PI;
      c.windFrom = Math.round(((to + 180) % 360 + 360) % 360 / 5) * 5;
      this.syncWind();
    };
    dial.addEventListener('pointerdown', (e) => { dial.setPointerCapture(e.pointerId); setFrom(e); });
    dial.addEventListener('pointermove', (e) => { if (dial.hasPointerCapture(e.pointerId)) setFrom(e); });
    dial.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -15 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 15 : 0;
      if (d) { e.preventDefault(); c.windFrom = (((c.windSettings().from + d) % 360) + 360) % 360; this.syncWind(); }
    });
    $('dice').addEventListener('click', () => {
      $('seed').value = 1 + Math.floor(Math.random() * 99999);
      $('scenario').value = 'random';
      this.generate();
    });
    $('generate').addEventListener('click', () => this.generate());
    $('speed').addEventListener('input', () => app.setSpeed(sliderToSpeed(+$('speed').value)));
    for (const t of document.querySelectorAll('.ticks span')) {
      // place each label exactly under its speed on the (logarithmic) slider
      const pct = speedToSlider(+t.dataset.speed) / 10;
      t.style.left = `${pct}%`;
      t.style.transform = pct < 3 ? 'none' : pct > 97 ? 'translateX(-100%)' : 'translateX(-50%)';
      t.addEventListener('click', () => app.setSpeed(+t.dataset.speed));
      t.tabIndex = 0; t.setAttribute('role', 'button');
      t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); app.setSpeed(+t.dataset.speed); } });
    }
    // free run: open-ended time (ends any timelapse)
    $('play').addEventListener('click', () => (sim.paused || app.tl ? app.freeRun() : app.pause()));
    window.addEventListener('keydown', (e) => {
      // Space pauses/resumes (or starts a timelapse when nothing is running) unless a control that
      // uses Space itself has the focus (a slider does not)
      if (e.code === 'Space' && !e.defaultPrevented && !usesSpace(document.activeElement)) {
        e.preventDefault();
        this.timelapseButton();
      }
    });
    $('collapse').addEventListener('click', () => this.collapse(true));
    $('expand').addEventListener('click', () => this.collapse(false));
    let hidden = false;
    try { hidden = localStorage.getItem('panel:collapsed') === '1'; } catch { /* storage unavailable */ }
    if (hidden) this.collapse(true);
  }

  collapse(on) {
    $('panel').classList.toggle('hidden', on);
    $('expand').classList.toggle('hidden', !on);
    document.body.classList.toggle('collapsed', on);
    try { localStorage.setItem('panel:collapsed', on ? '1' : '0'); } catch { /* storage unavailable */ }
  }

  // Ruggedness only shapes the random mountain range
  syncRugged() { $('rugged-row').hidden = $('scenario').value !== 'random'; }

  // A new province brings its home climate (Plateau: Utah desert, Rockies: Colorado alpine, Valley and
  // Ridge: Temperate, Gulf: Gulf Coast humid). Only when the province changes, so a climate you pick
  // yourself afterwards stands when you remake the same province.
  pickHomeClimate() {
    const prov = resolveProvince($('province').value, +$('seed').value);
    if (prov === this.climateFor) return;
    this.climateFor = prov;
    const home = PROVINCES[prov].climate;
    if (!home || !PRESETS[home] || home === this.app.sim.climate.presetName) return;
    this.setPreset(home);
    this.app.brushTool?.toast('climate', `Climate: ${home}`,
      `The ${PROVINCES[prov].name} comes with its home climate. You can pick a different one under Place & climate; it will stand until you change the geology.`);
  }

  generate() {
    // a seed from 1 to 99999 (a blank box or 0 would quietly make seed 0)
    const seed = Math.min(99999, Math.max(1, Math.round(+$('seed').value || 1)));
    $('seed').value = seed;
    this.pickHomeClimate();
    $('generate').classList.remove('pending');
    return this.app.load($('scenario').value, {
      size: +$('size').value,
      seed,
      ruggedness: +$('rugged').value,
      preset: this.app.sim.climate.presetName,
      province: $('province').value,
    }).catch((e) => {
      console.error(e);
      this.app.brushTool?.toast('miss', 'Could not make that landscape', String(e?.message || e));
    });
  }

  /** Reflect the engine's terrain settings into the controls (after a URL/API load). */
  syncTerrain(res) {
    const sim = this.app.sim;
    $('scenario').value = res.scenario;
    $('size').value = String(res.N);
    $('seed').value = res.seed;
    $('province').value = sim.province || 'plateau';
    this.climateFor = sim.provinceUsed;   // the province now loaded: only a change brings a new climate
    $('strata-info').textContent = sim.strataInfo
      ? `This landscape: ${sim.strataInfo.describe}${(sim.strataInfo.notes || []).map((n) => `
• ${n}`).join('')}` : '';
    $('rugged').value = sim.ruggedness;
    $('rugged-out').textContent = (+sim.ruggedness).toFixed(2);
    $('generate').classList.remove('pending');
    this.syncRugged();
    this.initialSolid = null;
  }

  /** Reflect speed, play state, timelapse and climate preset. */
  sync() {
    const { sim, tl } = this.app;
    $('speed').value = speedToSlider(sim.speed);
    $('speed-text').textContent = speedText(sim.speed);
    const freeRunning = !sim.paused && !tl;
    $('icon-pause').style.display = freeRunning ? '' : 'none';
    $('icon-play').style.display = freeRunning ? 'none' : '';
    // the big button: Start (no timelapse), Pause (running), Resume (paused part-way)
    const tlRunning = !!tl && !sim.paused;
    $('tl-icon-pause').style.display = tlRunning ? '' : 'none';
    $('tl-icon-play').style.display = tlRunning ? 'none' : '';
    const label = !tl ? 'Start timelapse' : tlRunning ? 'Pause timelapse' : 'Resume timelapse';
    $('tl-go').setAttribute('aria-label', label);
    $('tl-go-text').textContent = !tl ? 'Start' : tlRunning ? 'Pause' : 'Resume';
    $('tl-go').title = `${label} (space bar)`;
    $('tl-stop').hidden = !tl;
    $('tl-progress').hidden = !tl;
    for (const el of [$('tl-span'), $('tl-custom-n'), $('tl-custom-unit'), ...document.querySelectorAll('#tl-watch button')]) el.disabled = !!tl;
    $('timebar').classList.toggle('tl-active', !!tl);
    this.syncEstimate();
    this.updateProgress();
    this.syncPreset();
  }

  // ---------------- timelapse ----------------
  /** "1 day", "1 week", "3 months", "1,000 years" ... for a span in days. */
  spanText(days) {
    const n = (v) => (Math.round(v * 10) / 10).toLocaleString();
    if (days === 7) return '1 week';
    if (days === 30) return '1 month';
    if (days < 365) { const d = Math.round(days * 10) / 10; return `${n(d)} day${d === 1 ? '' : 's'}`; }
    const y = days / 365;
    return `${n(y)} year${Math.abs(y - 1) < 0.05 ? '' : 's'}`;
  }

  /** The span and watch length picked in the bar. */
  timelapseChoice() {
    let days;
    if ($('tl-span').value === 'custom') days = Math.max(0, +$('tl-custom-n').value || 0) * +$('tl-custom-unit').value;
    else days = +$('tl-span').value;
    const sel = document.querySelector('#tl-watch button[aria-checked="true"]');
    return { days, watchSec: sel ? +sel.dataset.sec : 30 };
  }

  bindTimelapse() {
    const app = this.app;
    // remembered choices
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('timelapse:choice') || 'null'); } catch { /* storage unavailable */ }
    if (saved) {
      if ([...$('tl-span').options].some((o) => o.value === saved.span)) $('tl-span').value = saved.span;
      if (saved.n > 0) $('tl-custom-n').value = saved.n;
      if (saved.unit) $('tl-custom-unit').value = saved.unit;
    }
    const watch = saved?.watch || 30;
    const chips = [...document.querySelectorAll('#tl-watch button')];
    const pick = (b) => { for (const c of chips) { c.setAttribute('aria-checked', String(c === b)); c.tabIndex = c === b ? 0 : -1; } };
    pick(chips.find((c) => +c.dataset.sec === watch) || chips[1]);
    const save = () => {
      try {
        localStorage.setItem('timelapse:choice', JSON.stringify({ span: $('tl-span').value, n: +$('tl-custom-n').value, unit: $('tl-custom-unit').value, watch: this.timelapseChoice().watchSec }));
      } catch { /* storage unavailable */ }
    };
    const changed = () => { $('tl-custom').hidden = $('tl-span').value !== 'custom'; this.syncEstimate(); save(); };
    $('tl-span').addEventListener('change', changed);
    $('tl-custom-n').addEventListener('input', changed);
    $('tl-custom-unit').addEventListener('change', changed);
    chips.forEach((c, i) => {
      c.addEventListener('click', () => { pick(c); changed(); });
      c.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        const n = chips[(i + d + chips.length) % chips.length];
        pick(n); n.focus(); changed();
      });
    });
    $('tl-custom').hidden = $('tl-span').value !== 'custom';
    $('tl-go').addEventListener('click', () => this.timelapseButton());
    $('tl-stop').addEventListener('click', () => app.stopTimelapse());
    // free-run drawer, closed unless it was left open
    let open = false;
    try { open = localStorage.getItem('dropdown:freerun') === '1'; } catch { /* storage unavailable */ }
    const setOpen = (on) => {
      $('freerun').hidden = !on;
      $('freerun-toggle').setAttribute('aria-expanded', String(on));
      $('freerun-toggle').classList.toggle('open', on);
      try { localStorage.setItem('dropdown:freerun', on ? '1' : '0'); } catch { /* storage unavailable */ }
    };
    setOpen(open);
    $('freerun-toggle').addEventListener('click', () => setOpen($('freerun').hidden));
    // the legend sits clear of the bar, whatever its height
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--timebar-h', `${$('timebar').offsetHeight}px`));
    ro.observe($('timebar'));
  }

  /** The big button and the space bar: start, pause or resume. */
  timelapseButton() {
    const { app } = this, sim = app.sim;
    if (app.tl) { sim.paused ? app.play() : app.pause(); return; }
    if (!sim.paused) { app.pause(); return; }            // free run going: space just pauses it
    const { days, watchSec } = this.timelapseChoice();
    if (!(days > 0)) { $('tl-custom-n').focus(); return; }
    this.rate = null;
    app.timelapse({ days, watchSec });
  }

  /** "1,000 years in about 30 s" under the controls (before a run). */
  syncEstimate() {
    const el = $('tl-estimate');
    if (this.app.tl) { el.textContent = ''; el.hidden = true; return; }
    el.hidden = false;
    const { days, watchSec } = this.timelapseChoice();
    if (!(days > 0)) { el.textContent = 'Type how much time should pass.'; el.className = 'tl-estimate warn'; return; }
    const speed = this.app.timelapseSpeed(days, watchSec);
    const secs = days / speed;
    const each = speedText(speed).replace(' / second', '');
    if (secs > watchSec * 1.05) {
      el.textContent = `Too long for ${fmtSecs(watchSec)} at top speed (about 1,000 years a second): it will take about ${fmtSecs(secs)}.`;
      el.className = 'tl-estimate warn';
    } else {
      el.textContent = `${this.spanText(days)} in about ${fmtSecs(secs)}: each second is ${each}.`;
      el.className = 'tl-estimate';
    }
  }

  /** Progress bar and "Year 340 of 1,000"; called every frame. */
  updateProgress() {
    const { tl, sim } = this.app;
    if (!tl) { this.rate = null; return; }
    const done = Math.min(tl.days, Math.max(0, sim.day - tl.startDay));
    $('tl-fill').style.width = `${(100 * done) / tl.days}%`;
    // measured pace (days per real second), so "time left" is honest on a slow graphics card too
    const now = performance.now();
    if (this.rate && !sim.paused && now > this.rate.t + 400) {
      const r = (sim.day - this.rate.day) / ((now - this.rate.t) / 1000);
      this.rate = { t: now, day: sim.day, v: this.rate.v ? this.rate.v * 0.6 + r * 0.4 : r };
    } else if (!this.rate || sim.paused) this.rate = { t: now, day: sim.day, v: this.rate?.v || 0 };
    const pace = this.rate.v > 0 ? this.rate.v : sim.speed;
    const left = (tl.days - done) / pace;
    const where = tl.days >= 730 ? `${Math.floor(done / 365).toLocaleString()} of ${Math.round(tl.days / 365).toLocaleString()} years passed`
      : `${Math.floor(done).toLocaleString()} of ${Math.round(tl.days).toLocaleString()} days passed`;
    $('tl-progress-text').textContent = `${where} · ${sim.paused ? 'paused' : `about ${fmtSecs(left)} left`}`;
  }

  // Sections marked class="dropdown" open and close from their heading; each remembers its state.
  bindDropdowns() {
    for (const sec of document.querySelectorAll('section.dropdown')) {
      const h = sec.querySelector(':scope > h2'), key = `dropdown:${sec.id}`;
      // remembered state, else the section's default (data-default-open: open on the first run)
      let open = sec.hasAttribute('data-default-open');
      try { const v = localStorage.getItem(key); if (v !== null) open = v === '1'; } catch { /* storage unavailable */ }
      sec.classList.toggle('open', open);
      h.tabIndex = 0; h.setAttribute('role', 'button'); h.setAttribute('aria-expanded', String(open));
      const toggle = () => {
        const now = sec.classList.toggle('open');
        h.setAttribute('aria-expanded', String(now));
        try { localStorage.setItem(key, now ? '1' : '0'); } catch { /* storage unavailable */ }
      };
      h.addEventListener('click', (e) => { if (!e.target.closest('.tip')) toggle(); });
      h.addEventListener('keydown', (e) => {
        if (e.target !== h) return;
        // handled here: Space must not also play/pause
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); toggle(); }
      });
    }
  }

  bindTooltips() {
    const tip = document.createElement('div');
    tip.id = 'tooltip';
    tip.className = 'hidden';
    document.body.appendChild(tip);
    const show = (t) => {
      tip.textContent = t.dataset.tip;
      tip.classList.remove('hidden');
      const r = t.getBoundingClientRect();
      const w = 260;
      let x = r.right + 8;
      if (x + w > window.innerWidth - 8) x = Math.max(8, r.left - w - 8);
      tip.style.left = `${x}px`;
      // measured after the text is in, so a long tip never runs off the bottom of the window
      const h = tip.offsetHeight;
      tip.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, r.top - 10))}px`;
    };
    document.addEventListener('mouseover', (e) => { const t = e.target.closest?.('.tip'); if (t) show(t); });
    document.addEventListener('mouseout', (e) => { if (e.target.closest?.('.tip')) tip.classList.add('hidden'); });
    document.addEventListener('focusin', (e) => { const t = e.target.closest?.('.tip'); if (t) show(t); });
    document.addEventListener('focusout', (e) => { if (e.target.closest?.('.tip')) tip.classList.add('hidden'); });
    // a "?" inside a checkbox label or button only explains: it must not tick the box or press the button
    document.addEventListener('click', (e) => {
      if (e.target.closest?.('.tip')) { e.preventDefault(); e.stopPropagation(); }
    }, true);
  }

  /** Date/weather card; called every frame. */
  updateHud() {
    const sim = this.app.sim;
    this.updateProgress();
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
    // what the viewer is actually seeing: seasons stroboscopic (about 1 year per 4 s) only in the
    // time-lapse mode, weather averaged once a frame spans more than a couple of days
    const each = speedText(sim.speed).replace(' / second', '');
    $('hud-lapse').textContent = sim.running ? 'Fast-forwarding...'
      : sim.paused || !fast ? ''
      : sim.strobe ? `Time-lapse: each second is about ${each}; seasons shown at about 1 year per 4 s`
      : `Each second is about ${each}; day-to-day weather is averaged`;
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
      ['Water stored as glacier ice', fmtVol(t.iceWater_m3 || 0)],
      ['Water soaked into the ground', fmtVol(t.totalGroundwater_m3)],
      ['Rain & snow that fell', fmtVol(t.cumPrecip_m3)],
      ['Flowed off the map', fmtVol(t.cumOutflow_m3)],
      ['Evaporated or used by plants', fmtVol(t.cumEvapLoss_m3)],
      ['All water accounted for', `<span class="${ok ? 'good' : 'bad'}">${t.hasNaN ? 'ERROR (NaN)' : err < 0.001 ? 'yes' : `off by ${err.toFixed(3)}%`}</span>`],
      'sep',
      ['Ground covered by plants', `${Math.round(100 * (t.vegCoveredFrac ?? 0))}%`],
      ['Recently burned', `${(100 * (t.burnedFrac ?? 0)).toFixed(1)}%`],
      'sep',
      ['Rock & soil carried away', fmtVol(Math.max(0, lost))],
      ['Highest point', `${Math.round(t.maxHeight).toLocaleString()} m`],
      ['Lowest point', `${Math.round(t.minHeight).toLocaleString()} m`],
      ...((t.archesStanding || t.archesFallen) ? [['Natural arches', `${t.archesStanding} standing${t.bridgesStanding ? ` (${t.bridgesStanding} bridge${t.bridgesStanding === 1 ? '' : 's'})` : ''}, ${t.archesFallen} fallen`]] : []),
    ];
    $('stats').innerHTML = rows.map((r) => (r === 'sep' ? '<div class="sep"></div>' : `<span class="k">${r[0]}</span><span class="v">${r[1]}</span>`)).join('')
      + `<div class="tech">${Math.round(info.fps)} frames/s &middot; ${info.adapter || 'graphics card ?'}</div>`;
  }
}
