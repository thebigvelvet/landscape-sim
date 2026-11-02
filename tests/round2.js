// Round 2 test suite (plants, soil, weather brushes). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/round2.js --out=tests/out-round2.json
// Every check records its numbers and a pass flag; `allPass` summarises.
const e = sim.engine;
const R = { checks: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const layer = (n) => e.readLayer(n);
const ground = async () => { const b = await layer('bedrock'), s = await layer('soil'); for (let i = 0; i < b.length; i++) b[i] += s[i]; return b; };
const discMean = (a, N, cx, cy, r) => { let s = 0, n = 0; for (let y = Math.floor(cy - r); y <= cy + r; y++) for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) { s += a[y * N + x]; n++; } return s / n; };
const t0 = performance.now();

// 1. Water balance with plants and with each brush, at real-time hydrology (1 day/s-like batches)
//    and at 1000 yr/s batches. Also no NaN.
{
  const rows = {};
  for (const [label, batchDays, days] of [['1 day/s', 1 / 60, 20], ['1000 yr/s', 6083, 6083 * 3]]) {
    for (const brush of ['none', 'storm', 'drought', 'flood', 'wildfire']) {
      await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' });
      sim.pause();
      await e.run(2, { batchDays: Math.min(batchDays, 1) });
      const N = e.N;
      if (brush !== 'none') sim.brush(brush, { x: N * 0.5, y: N * 0.55, radius: 20, days: brush === 'flood' ? 0.5 : undefined });
      await e.run(days, { batchDays });
      const s = await sim.stats();
      rows[`${label} ${brush}`] = { balPct: s.balanceErrorPct, precip_m3: s.cumPrecip_m3, nan: s.hasNaN, meanVeg: s.meanVeg, burnedFrac: s.burnedFrac };
    }
  }
  const worst = Math.max(...Object.values(rows).map((r) => Math.abs(r.balPct)));
  check('waterBalance', worst < 0.01 && Object.values(rows).every((r) => !r.nan), { worstAbsPct: worst, rows });
}

// 2. No NaN, live: 10 s at 1 day/s and 10 s at 1000 yr/s with rendering, with a fire and a storm.
{
  await sim.load('random', { size: 512, seed: 7, preset: 'Temperate' });
  const N = e.N;
  sim.setSpeed(1); sim.play();
  sim.brush('wildfire', { x: N * 0.4, y: N * 0.5, radius: 15 });
  sim.brush('storm', { x: N * 0.6, y: N * 0.5, radius: 20 });
  await sleep(6000);
  const a = await sim.stats();
  const fpsSlow = e.fps;
  sim.setSpeed(365000);
  sim.brush('flood', { x: N * 0.5, y: N * 0.3 });
  sim.brush('drought', { x: N * 0.5, y: N * 0.5 });
  await sleep(8000);
  const b = await sim.stats();
  sim.pause();
  check('noNaN', !a.hasNaN && !b.hasNaN && (window.__gpuErrors || 0) === 0, { slow: { nan: a.hasNaN, bal: a.balanceErrorPct, fps: fpsSlow }, fast: { nan: b.hasNaN, bal: b.balanceErrorPct, years: b.year, fps: e.fps }, gpuErrors: window.__gpuErrors || 0 });
}

// 3. A burned patch erodes more than an identical unburned one. The cone is symmetric east-west
//    (aspect only matters north-south), so burn a patch on the east flank and compare it with its
//    mirror image on the west flank.
{
  await sim.load('cone', { size: 256, seed: 1, preset: 'Temperate' });
  sim.pause();
  const N = e.N, c = (N - 1) / 2, off = 55, r = 14;
  const xb = c + off, xu = c - off, y = c;
  const g0 = await ground();
  sim.brush('wildfire', { x: xb, y, radius: r });
  e.events.fireWeather = 0;                       // no spread: compare like with like
  await e.run(0.2, { batchDays: 0.01 });          // let it burn (fire runs per batch)
  const vegB = discMean(await layer('veg'), N, xb, y, r), vegU = discMean(await layer('veg'), N, xu, y, r);
  const burnB = discMean(await layer('burn'), N, xb, y, r);
  for (let k = 0; k < 4; k++) { e.climate.triggerStorm(3, 12); await e.run(90); }
  const g1 = await ground();
  const d = new Float32Array(N * N); for (let i = 0; i < d.length; i++) d[i] = g0[i] - g1[i];
  const eroB = discMean(d, N, xb, y, r), eroU = discMean(d, N, xu, y, r);
  check('burnErodesMore', eroB > 1.5 * Math.max(eroU, 1e-6), { erosionBurned_m: eroB, erosionUnburned_m: eroU, ratio: eroB / Math.max(eroU, 1e-9), vegAfterFire: vegB, vegUnburned: vegU, burnSeverity: burnB });
}

// 4. Plants recover after fire.
{
  await sim.load('random', { size: 256, seed: 3, preset: 'Temperate' });
  sim.pause();
  const N = e.N, x = N * 0.5, y = N * 0.5, r = 25;
  const v0 = discMean(await layer('veg'), N, x, y, r);
  const w0 = discMean((await layer('plant')).filter((_, i) => i % 4 === 0), N, x, y, r);
  sim.brush('wildfire', { x, y, radius: r });
  e.events.fireWeather = 0;
  await e.run(0.3, { batchDays: 0.01 });
  const v1 = discMean(await layer('veg'), N, x, y, r), b1 = discMean(await layer('burn'), N, x, y, r);
  const series = [];
  for (const yrs of [1, 2, 5, 10, 30, 60]) {
    await e.run(yrs * 365 - (series.length ? series[series.length - 1].yrs * 365 : 0));
    const pl = await layer('plant');
    series.push({ yrs, veg: discMean(await layer('veg'), N, x, y, r), woody: discMean(pl.filter((_, i) => i % 4 === 0), N, x, y, r), burn: discMean(await layer('burn'), N, x, y, r) });
  }
  const last = series[series.length - 1];
  check('recoveryAfterFire', v1 < 0.5 * v0 && series[1].veg > v1 && last.veg > 0.85 * v0 && last.burn < 0.02, { before: { veg: v0, woody: w0 }, justAfter: { veg: v1, burn: b1 }, series });
}

// 5. Utah desert has less cover than the Pacific NW (and the other presets, for the record).
{
  const cover = {};
  for (const p of ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']) {
    await sim.load('random', { size: 256, seed: 3, preset: p });
    sim.pause();
    await e.run(365 * 20);
    const s = await sim.stats();
    cover[p] = { meanVeg: s.meanVeg, vegCoveredFrac: s.vegCoveredFrac, meanWoodyCover: s.meanWoodyCover, bal: s.balanceErrorPct };
  }
  check('desertVsWet', cover['Utah desert'].meanVeg < 0.5 * cover['Pacific NW wet'].meanVeg, cover);
}

// 6. Treeline: on the Colorado cone, woody cover by elevation band.
{
  await sim.load('cone', { size: 256, seed: 1, preset: 'Colorado alpine' });
  sim.pause();
  await e.run(365 * 20);
  const N = e.N, g = await ground(), v = await layer('veg'), pl = await layer('plant');
  const zs = Array.from(g).sort((a, b) => a - b);
  const bands = [];
  for (let k = 0; k < 6; k++) {
    const lo = zs[Math.floor(k / 6 * (zs.length - 1))], hi = zs[Math.floor((k + 1) / 6 * (zs.length - 1))];
    let sv = 0, sw = 0, n = 0;
    for (let i = 0; i < g.length; i++) if (g[i] >= lo && g[i] <= hi) { sv += v[i]; sw += v[i] * pl[4 * i]; n++; }
    bands.push({ elev_m: Math.round(lo + e.datum) + '-' + Math.round(hi + e.datum), cover: sv / n, treeCover: sw / n });
  }
  check('treeline', bands[0].treeCover > 0.2 && bands[5].treeCover < 0.03 && bands[5].cover > 0.01, { bands });
}

// 7. The brush lands where clicked: synthetic pointer events on the canvas at the screen position
//    of known grid cells, then compare the event's cell with the target.
{
  await sim.load('random', { size: 512, seed: 2, preset: 'Colorado alpine' });
  sim.pause();
  await sim.refreshHeights();
  await sleep(300);
  const cv = sim.renderer.canvas;
  const targets = [[256, 256], [180, 300], [340, 210], [300, 360]];
  const hits = [];
  sim.setTool('storm');
  for (const [tx, ty] of targets) {
    const sp = sim.screenOf(tx, ty);
    const opt = { clientX: sp.x, clientY: sp.y, button: 0, buttons: 1, pointerId: 1, bubbles: true, isPrimary: true };
    cv.dispatchEvent(new PointerEvent('pointermove', { ...opt, buttons: 0 }));
    cv.dispatchEvent(new PointerEvent('pointerdown', opt));
    cv.dispatchEvent(new PointerEvent('pointerup', opt));
    const ev = e.events.log[e.events.log.length - 1];
    hits.push({ target: [tx, ty], got: [+ev.x.toFixed(2), +ev.y.toFixed(2)], err: Math.hypot(ev.x - tx, ev.y - ty) });
  }
  // the wildfire burns where it was put
  sim.setTool('wildfire');
  const sp = sim.screenOf(200, 260);
  cv.dispatchEvent(new PointerEvent('pointerdown', { clientX: sp.x, clientY: sp.y, button: 0, buttons: 1, pointerId: 1, bubbles: true }));
  cv.dispatchEvent(new PointerEvent('pointerup', { clientX: sp.x, clientY: sp.y, button: 0, pointerId: 1, bubbles: true }));
  e.events.fireWeather = 0;
  await e.run(0.2, { batchDays: 0.01 });
  const burn = await layer('burn'); const N = e.N;
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const b = burn[y * N + x]; if (b > 0.05) { sx += x * b; sy += y * b; sw += b; } }
  const centroid = [sx / sw, sy / sw];
  sim.setTool('none');
  const worst = Math.max(...hits.map((h) => h.err));
  check('brushLandsWhereClicked', worst < 1.5 && Math.hypot(centroid[0] - 200, centroid[1] - 260) < 3, { hits, worstErrCells: worst, fireTarget: [200, 260], burnCentroid: centroid });
}

// 8. Speed scaling: a 3-day storm adds the same water at 1 day/s-sized batches and at 1000 yr/s.
{
  const extra = {};
  for (const [label, bd] of [['realtime', 1 / 60], ['1000 yr/s', 6083]]) {
    const run = async (withStorm) => {
      await sim.load('random', { size: 256, seed: 5, preset: 'Temperate' });
      sim.pause();
      if (withStorm) sim.brush('storm', { x: 128, y: 128, radius: 30, days: 3 });
      await e.run(bd > 3 ? bd : 4, { batchDays: bd });
      return (await sim.stats()).cumPrecip_m3;
    };
    extra[label] = (await run(true)) - (await run(false));
  }
  // expected: integral of the bell over the grid x 0.08 m/day x 3 days x 100 m2
  let w = 0; for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) { const d = Math.hypot(x - 128, y - 128) / 30; if (d < 1) w += 0.5 + 0.5 * Math.cos(Math.PI * d); }
  const expected = w * 0.08 * 3 * 100;
  check('stormSpeedScaling', Math.abs(extra.realtime / expected - 1) < 0.02 && Math.abs(extra['1000 yr/s'] / expected - 1) < 0.02, { expected_m3: expected, ...extra });
}

// 9. Flood: the surge travels; water is counted.
{
  await sim.load('valley', { size: 256, seed: 1, preset: 'Temperate' });
  sim.pause();
  const s0 = await sim.stats();
  sim.brush('flood', { x: 128, y: 20 });
  const depth = [];
  for (let k = 0; k < 6; k++) { await e.run(0.1, { batchDays: 1 / 60 }); const w = await layer('water'); let m = 0, my = 0; for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (w[y * 256 + x] > 0.3 && y > my) { my = y; } const s = await sim.stats(); depth.push({ day: +s.day.toFixed(2), maxDepth: s.maxWaterDepth, frontRow: my }); }
  const s = await sim.stats();
  check('floodSurge', s.maxWaterDepth > s0.maxWaterDepth + 0.5 && depth[5].frontRow > depth[0].frontRow && Math.abs(s.balanceErrorPct) < 0.01, { depth, balPct: s.balanceErrorPct, floodVolume_m3: 0.5 * 150 * 0.5 * 86400 });
}

// 10. Drought browns the land and drains groundwater; it recovers afterwards.
{
  const res = {};
  for (const withD of [false, true]) {
    await sim.load('random', { size: 256, seed: 3, preset: 'Temperate' });
    sim.pause();
    await e.run(365 * 5);
    const a = await sim.stats();
    if (withD) sim.brush('drought', { x: 128, y: 128, days: 5 * 365 });
    await e.run(365 * 5);
    const b = await sim.stats();
    await e.run(365 * 15);
    const c = await sim.stats();
    res[withD ? 'drought' : 'normal'] = { veg: [a.meanVeg, b.meanVeg, c.meanVeg], gw_m3: [a.totalGroundwater_m3, b.totalGroundwater_m3, c.totalGroundwater_m3], bal: c.balanceErrorPct };
  }
  check('drought', res.drought.veg[1] < 0.8 * res.normal.veg[1] && res.drought.gw_m3[1] < 0.8 * res.normal.gw_m3[1] && res.drought.veg[2] > 0.9 * res.normal.veg[2], res);
}

R.allPass = Object.values(R.checks).every((c) => c.pass);
R.failed = Object.entries(R.checks).filter(([, c]) => !c.pass).map(([k]) => k);
R.wallSeconds = (performance.now() - t0) / 1000;
return R;
