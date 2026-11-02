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
      sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' });
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
  sim.pause(); await sim.load('random', { size: 512, seed: 7, preset: 'Temperate' });
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

// 3. A burned patch erodes more than an identical unburned one: the same landscape (V-shaped
//    valley, planar hillslopes at ~0.35, below the angle of repose) is run twice with the same
//    weather, once with a fire on the east valley wall and once without, and the ground lowering
//    inside the patch is compared. Then four big storms.
{
  const site = { x: 190, y: 140, r: 14 };
  const runOnce = async (burnIt) => {
    sim.pause(); await sim.load('valley', { size: 256, seed: 1, preset: 'Temperate' });
    sim.pause();
    const N = e.N;
    await e.run(365 * 20);
    const g0 = await ground();
    const vegBefore = discMean(await layer('veg'), N, site.x, site.y, site.r);
    if (burnIt) { sim.brush('wildfire', { x: site.x, y: site.y, radius: site.r }); e.events.fireWeather = 0; }
    await e.run(0.2, { batchDays: 0.01 });
    const vegAfter = discMean(await layer('veg'), N, site.x, site.y, site.r);
    // two cloudbursts over the patch (identical in both runs), then the rest of the year
    for (let k = 0; k < 2; k++) { sim.brush('storm', { x: site.x, y: site.y - 10, radius: 30 }); await e.run(30); }
    await e.run(300);
    const g1 = await ground();
    const d = new Float32Array(N * N); for (let i = 0; i < d.length; i++) d[i] = g0[i] - g1[i];
    let maxCut = 0; for (let y = site.y - site.r; y <= site.y + site.r; y++) for (let x = site.x - site.r; x <= site.x + site.r; x++) maxCut = Math.max(maxCut, d[y * N + x]);
    const st = await sim.stats();
    return { maxCut_m: maxCut, vegBefore, vegAfter, lowering_m: discMean(d, N, site.x, site.y, site.r), burn: discMean(await layer('burn'), N, site.x, site.y, site.r), sedimentOutOfMap_m3: st.cumSedimentOut_m3, bal: st.balanceErrorPct };
  };
  const un = await runOnce(false);
  const bu = await runOnce(true);
  check('burnErodesMore', bu.lowering_m > 1.5 * Math.max(un.lowering_m, 1e-4) && bu.lowering_m > 0.0005, { site, burned: bu, unburned: un, ratio: bu.lowering_m / Math.max(un.lowering_m, 1e-9) });
}

// 4. Plants recover after fire.
{
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Temperate' });
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
    sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: p });
    sim.pause();
    await e.run(365 * 20);
    const s = await sim.stats();
    cover[p] = { meanVeg: s.meanVeg, vegCoveredFrac: s.vegCoveredFrac, meanWoodyCover: s.meanWoodyCover, bal: s.balanceErrorPct };
  }
  check('desertVsWet', cover['Utah desert'].meanVeg < 0.5 * cover['Pacific NW wet'].meanVeg, cover);
}

// 6. Treeline: on the Colorado cone, woody cover by elevation band.
{
  sim.pause(); await sim.load('cone', { size: 256, seed: 1, preset: 'Colorado alpine' });
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

// 7. The brush lands where clicked. (a) Synthetic clicks on the canvas at the screen position of
//    visible grid cells; (b) round trip for a grid of screen points: click -> event cell -> project
//    the cell back to the screen, which must be the clicked pixel (cells hidden behind a ridge are
//    correctly not reachable, so (b) is the general test); (c) a wildfire burns where it was put.
{
  sim.pause(); await sim.load('random', { size: 512, seed: 2, preset: 'Colorado alpine' });
  sim.pause();
  await sim.refreshHeights();
  await sleep(300);
  const cv = sim.renderer.canvas;
  const click = (x, y) => {
    const opt = { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, bubbles: true, isPrimary: true };
    cv.dispatchEvent(new PointerEvent('pointermove', { ...opt, buttons: 0 }));
    cv.dispatchEvent(new PointerEvent('pointerdown', opt));
    cv.dispatchEvent(new PointerEvent('pointerup', opt));
    return e.events.log[e.events.log.length - 1];
  };
  sim.setTool('storm');
  const hits = [];
  for (const [tx, ty] of [[256, 256], [180, 300], [145, 142], [370, 429]]) {
    const sp = sim.screenOf(tx, ty);
    const ev = click(sp.x, sp.y);
    hits.push({ target: [tx, ty], got: [+ev.x.toFixed(2), +ev.y.toFixed(2)], err: Math.hypot(ev.x - tx, ev.y - ty) });
  }
  const rect = cv.getBoundingClientRect();
  const trips = [];
  for (let fy = 0.3; fy <= 0.8; fy += 0.125) for (let fx = 0.45; fx <= 0.9; fx += 0.15) {
    const px = rect.left + fx * rect.width, py = rect.top + fy * rect.height;
    const n0 = e.events.seq;
    const ev = click(px, py);
    if (e.events.seq === n0) continue;   // missed the map (sky)
    if (ev.x < 1 || ev.y < 1 || ev.x > e.N - 2 || ev.y > e.N - 2) continue;   // clicked the side of the block
    const back = sim.screenOf(ev.x, ev.y);
    trips.push({ px: [Math.round(px), Math.round(py)], cell: [+ev.x.toFixed(1), +ev.y.toFixed(1)], errPx: Math.hypot(back.x - px, back.y - py) });
  }
  sim.setTool('wildfire');
  const sp = sim.screenOf(200, 260);
  click(sp.x, sp.y);
  e.events.fireWeather = 0;
  await e.run(0.2, { batchDays: 0.01 });
  const burn = await layer('burn'); const N = e.N;
  let sx = 0, sy = 0, sw = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { const b = burn[y * N + x]; if (b > 0.05) { sx += x * b; sy += y * b; sw += b; } }
  const centroid = [sx / sw, sy / sw];
  sim.setTool('none');
  const worst = Math.max(...hits.map((h) => h.err)), worstPx = Math.max(...trips.map((t) => t.errPx));
  check('brushLandsWhereClicked', worst < 1.5 && worstPx < 1.5 && trips.length >= 10 && Math.hypot(centroid[0] - 200, centroid[1] - 260) < 3,
    { hits, worstErrCells: worst, roundTrips: trips.length, worstRoundTripPx: worstPx, fireTarget: [200, 260], burnCentroid: centroid });
}

// 8. Speed scaling: a 3-day storm adds the same water at 1 day/s-sized batches and at 1000 yr/s.
{
  const extra = {};
  for (const [label, bd] of [['realtime', 1 / 60], ['1000 yr/s', 6083]]) {
    const run = async (withStorm) => {
      sim.pause(); await sim.load('random', { size: 256, seed: 5, preset: 'Temperate' });
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

// 9. Flood: a surge put in high up the valley races down it (the valley drains to row 0); the
//    water is counted.
{
  sim.pause(); await sim.load('valley', { size: 256, seed: 1, preset: 'Temperate' });
  sim.pause();
  const s0 = await sim.stats();
  sim.brush('flood', { x: 128, y: 220 });
  const track = [];
  for (let k = 0; k < 12; k++) {
    await e.run(k < 8 ? 0.01 : 0.1, { batchDays: 1 / 60 });
    const w = await layer('water');
    let front = 256;
    for (let y = 0; y < 256; y++) { let deep = false; for (let x = 100; x < 156; x++) if (w[y * 256 + x] > 0.2) deep = true; if (deep) { front = y; break; } }
    const s = await sim.stats();
    track.push({ day: +s.day.toFixed(2), maxDepth: +s.maxWaterDepth.toFixed(2), frontRow: front, water_m3: Math.round(s.totalWater_m3) });
  }
  const s = await sim.stats();
  check('floodSurge', Math.max(...track.map((t) => t.maxDepth)) > s0.maxWaterDepth + 0.5 && track[0].frontRow - Math.min(...track.map((t) => t.frontRow)) > 50 && Math.abs(s.balanceErrorPct) < 0.01,
    { start: { maxDepth: s0.maxWaterDepth }, track, balPct: s.balanceErrorPct, floodVolume_m3: 0.5 * 150 * 0.5 * 86400 });
}

// 10. Drought browns the land and drains groundwater; it recovers afterwards.
{
  const res = {};
  for (const withD of [false, true]) {
    sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Temperate' });
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
