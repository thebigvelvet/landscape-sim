(async () => {
  const $ = (id) => document.getElementById(id);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const S = window.sim, E = S.engine, R = S.renderer;
  const log = []; const ok = (name, cond, info) => log.push(`${cond ? 'PASS' : 'FAIL'} ${name}${info !== undefined ? ' — ' + info : ''}`);
  const errs0 = window.__gpuErrors || 0;
  const loaded = async () => { for (let k = 0; k < 200; k++) { await wait(100); if ($('loading').classList.contains('fade') && !E.running) return true; } return false; };
  await S.load('random', { size: 256, seed: 3, preset: 'Colorado alpine' });
  // play at 1 day/s
  document.querySelector('.ticks span[data-speed="1"]').click(); S.play();
  const d0 = E.day; await wait(3000);
  ok('time runs at ~1 day/s', E.day - d0 > 2 && E.day - d0 < 4.5, (E.day - d0).toFixed(2) + ' days in 3 s');
  ok('date card shows a date', /Year 1 · \d+ \w+/.test($('hud-date').textContent), $('hud-date').textContent);
  // big storm
  $('storm').click(); await wait(800);
  const pr = E.lastClimate.precipRate_mm_per_day, mean = E.climate.precipAt(E.lastClimate.dayOfYear);
  ok('big storm rains hard', pr > 8 * mean, `${pr.toFixed(1)} mm/day vs normal ${mean.toFixed(1)}`);
  ok('weather card says storm', $('hud-weather').textContent === 'Big storm!', $('hud-weather').textContent);
  // preset card
  document.querySelector('.preset[data-preset="Utah desert"]').click(); await wait(300);
  ok('Utah card switches climate', E.climate.presetName === 'Utah desert' && E.datum === 1400, E.climate.presetName);
  ok('Utah blurb shown', /Colorado Plateau/.test($('preset-blurb').textContent));
  // sliders
  $('temp').value = 3; $('temp').dispatchEvent(new Event('input'));
  $('precip').value = 1; $('precip').dispatchEvent(new Event('input'));
  $('erosion').value = 1; $('erosion').dispatchEvent(new Event('input'));
  ok('sliders reach the engine', E.climate.tempOffset === 3 && Math.abs(E.climate.precipMul - 2) < 1e-9 && Math.abs(E.erosionStrength - 2) < 1e-9, `${E.climate.tempOffset} °C, ${E.climate.precipMul}x rain, ${E.erosionStrength}x erosion`);
  $('vex').value = 2; $('vex').dispatchEvent(new Event('input'));
  ok('height exaggeration reaches renderer', R.vex === 2);
  // overlays
  const opts = [...document.querySelectorAll('.overlay-opt')];
  let ovOk = true;
  for (const o of opts) { o.click(); await wait(150); if (R.mode !== +o.dataset.id || (R.mode > 0 && $('legend').classList.contains('hidden'))) ovOk = false; }
  ok(`all ${opts.length} views switch and show a legend`, ovOk && opts.length === 13);
  opts[0].click();
  // fast speed
  document.querySelector('.ticks span[data-speed="365000"]').click();
  const y0 = E.day / 365; await wait(3000);
  const yrs = E.day / 365 - y0;
  ok('1000 yr/s runs ~3000 years in 3 s', yrs > 1500 && yrs < 4000, yrs.toFixed(0) + ' years');
  ok('weather card says averaged at speed', $('hud-weather').textContent === 'Weather averaged', $('hud-weather').textContent);
  // space bar pause
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' })); await wait(300);
  const dp = E.day; await wait(600);
  ok('space bar pauses', E.paused && E.day === dp);
  window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space' }));
  ok('space bar resumes', !E.paused);
  document.querySelector('.ticks span[data-speed="30"]').click();
  // generate while running, then a new size (world rebuilt)
  $('scenario').value = 'cone'; $('generate').click(); ok('make landscape while running (cone)', await loaded() && E.scenario === 'cone');
  $('dice').click(); ok('surprise me makes a random landscape', await loaded() && E.scenario === 'random', 'seed ' + E.seed);
  $('size').value = '1024'; $('generate').click(); ok('switch to High detail (1024)', await loaded() && E.N === 1024);
  await wait(2000);
  $('size').value = '256'; $('generate').click(); ok('back to Low detail (256)', await loaded() && E.N === 256);
  await wait(1500);
  // collapse / expand
  $('collapse').click(); await wait(200); const hid = $('panel').classList.contains('hidden');
  $('expand').click(); await wait(200);
  ok('panel hides and returns', hid && !$('panel').classList.contains('hidden'));
  // stats panel and health
  await wait(1200);
  const st = await S.stats();
  ok('water books balance', Math.abs(st.balanceErrorPct) < 0.01 && !st.hasNaN, st.balanceErrorPct.toExponential(2) + ' %');
  ok('stats panel filled', /accounted/.test($('stats').textContent) && /nvidia/i.test($('stats').textContent));
  ok('no GPU errors during the session', (window.__gpuErrors || 0) === errs0, String((window.__gpuErrors || 0) - errs0));
  ok('frame rate', st.fps > 50, st.fps.toFixed(0) + ' fps');
  document.querySelector('.ticks span[data-speed="3"]')?.click();
  return log;
})()
