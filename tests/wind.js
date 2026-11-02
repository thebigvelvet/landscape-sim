// Wind (sim/wind.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/wind.js --out=tests/out-wind.json
// A flat 4 m sheet of loose sand on a 256 x 256 Utah map is the test bed for the dunes:
//   dunes       under a steady west wind, dunes grow out of the flat sheet, travel downwind (east),
//               and have gentle windward slopes and steeper lee slip faces near the sand's 33 degrees
//   steadiness  a steady wind builds crests across the wind; two winds trading off by season build
//               ridges along the mean wind (orientation from the height-gradient structure tensor)
//   direction   turning the wind to come from the north turns the crests and the travel with it
//   protected   the same sheet in the wet, green Pacific NW, and a sheet capped by a gravel pavement,
//               barely change
//   abrasion    sand blown across bare layered rock wears soft beds faster than hard ones
//   snow        in the Colorado alpine, snow drifts into sheltered lee cells and out of exposed ones
//   books       solids and water stay balanced with the wind on (blown off the edge is logged)
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();
const pct = (a, q) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const deg = (t) => (Math.atan(t) * 180) / Math.PI;

// load a map, then replace its ground by a gently tilted plate under `sand` m of loose sand
// (top bed grain `grain`, gravel 1.0 makes a pavement); returns the starting heights
async function sandSheet(preset, { sand = 4, grain = 0.62, capGravel = 0 } = {}) {
  sim.pause(); await sim.load('random', { size: 256, seed: 5, preset }); sim.pause();
  const N = e.N, q = e.device.queue, B = e.world.buffers;
  let rng = 99; const rnd = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
  const br = new Float32Array(N * N), so = new Float32Array(N * N), h0 = new Float32Array(N * N), dep = new Float32Array(N * N * 16);
  for (let i = 0; i < N * N; i++) {
    br[i] = 50 - 0.02 * (i % N); so[i] = sand + 0.05 * (rnd() - 0.5); h0[i] = br[i] + so[i];
    if (capGravel > 0) { dep[16 * i] = capGravel; dep[16 * i + 8] = 0.99; dep[16 * i + 1] = so[i] - capGravel; dep[16 * i + 9] = 0.99 * grain; }
    else { dep[16 * i] = so[i]; dep[16 * i + 8] = 0.99 * grain; }
  }
  q.writeBuffer(B.bedrock, 0, br); q.writeBuffer(B.soil, 0, so); q.writeBuffer(B.initHeight, 0, h0); q.writeBuffer(B.deposit, 0, dep);
  await q.onSubmittedWorkDone();
  return h0;
}
async function anomaly(h0) {
  const b = await layer('bedrock'), s = await layer('soil'), g = new Float32Array(b.length);
  for (let i = 0; i < g.length; i++) g[i] = b[i] + s[i] - h0[i];
  return g;
}
// shape numbers: relief, lee and stoss slopes along the wind (unit vector d, grid), gradient angle
// relative to the wind (0 = crests across the wind, 90 = crests along it) and its coherence
function shape(g, N, d) {
  let mn = Infinity, mx = -Infinity;
  const lee = [], stoss = [];
  let gxx = 0, gyy = 0, gxy = 0;
  for (let y = 8; y < N - 8; y++) for (let x = 8; x < N - 8; x++) {
    const i = y * N + x;
    mn = Math.min(mn, g[i]); mx = Math.max(mx, g[i]);
    const gx = (g[i + 1] - g[i - 1]) / 20, gy = (g[i + N] - g[i - N]) / 20;
    const along = gx * d[0] + gy * d[1];   // ground rising downwind = windward (stoss) face
    if (Math.hypot(gx, gy) > 0.09) (along > 0 ? stoss : lee).push(Math.abs(along));
    gxx += gx * gx; gyy += gy * gy; gxy += gx * gy;
  }
  const a = 0.5 * Math.atan2(2 * gxy, gxx - gyy);      // dominant gradient direction
  const rel = Math.abs(((a - Math.atan2(d[1], d[0])) * 180) / Math.PI) % 180;
  return { relief: mx - mn, leeP90deg: deg(pct(lee, 0.9)), stossP90deg: deg(pct(stoss, 0.9)), leeMedDeg: deg(pct(lee, 0.5)), stossMedDeg: deg(pct(stoss, 0.5)),
    crestAngleToWind: Math.min(rel, 180 - rel), coherence: Math.sqrt((gxx - gyy) ** 2 + 4 * gxy * gxy) / (gxx + gyy) };
}
// downwind travel between two anomaly maps (cells), by cross-correlating profiles along d
function travel(g1, g2, N, d) {
  let best = 0, bestC = -Infinity;
  for (let lag = -12; lag <= 12; lag++) {
    let c = 0;
    for (let y = 40; y < N - 40; y += 2) for (let x = 40; x < N - 40; x += 2) {
      const i = y * N + x, j = (y + Math.round(lag * d[1])) * N + x + Math.round(lag * d[0]);
      c += g1[i] * g2[j];
    }
    if (c > bestC) { bestC = c; best = lag; }
  }
  return best;
}

// ---- dunes under a steady west wind ----
{
  const h0 = await sandSheet('Utah desert');
  sim.setWind({ from: 270, speed: 1.2, steady: 1, on: true });
  await e.run(250 * 365);
  const g1 = await anomaly(h0);
  await e.run(50 * 365);
  const g2 = await anomaly(h0);
  const s = await sim.stats(), N = e.N, d = [1, 0];
  const sh = shape(g2, N, d), mv = travel(g1, g2, N, d);
  R.runs.steady = { ...sh, travelCells50yr: mv, solidsError_m3: s.solidsError_m3, sedOut_m3: s.cumSedimentOut_m3, balPct: s.balanceErrorPct, nan: s.hasNaN };
  check('dunesForm', sh.relief > 5 && sh.relief < 60, { relief_m: sh.relief });
  check('dunesTravelDownwind', mv >= 1, { cellsIn50yr: mv });
  check('slipFaces', sh.leeP90deg > sh.stossP90deg && sh.leeP90deg > 20 && sh.leeP90deg < 40, { leeP90deg: sh.leeP90deg, stossP90deg: sh.stossP90deg });
  check('crestsAcrossSteadyWind', sh.crestAngleToWind < 25 && sh.coherence > 0.4, { gradientAngleToWind: sh.crestAngleToWind, coherence: sh.coherence });
  check('booksSand', !s.hasNaN && Math.abs(s.solidsError_m3) < 1e-3 * s.cumSedimentOut_m3 + 500 && Math.abs(s.balanceErrorPct) < 0.01,
    { solidsError_m3: s.solidsError_m3, sedOut_m3: s.cumSedimentOut_m3, balPct: s.balanceErrorPct });
}
// ---- two seasonal winds: ridges along the mean wind ----
{
  const h0 = await sandSheet('Utah desert');
  sim.setWind({ from: 270, speed: 1.2, steady: 0.5 });
  await e.run(300 * 365);
  const sh = shape(await anomaly(h0), e.N, [1, 0]);
  R.runs.bimodal = sh;
  check('linearDunesAlongWind', sh.crestAngleToWind > 60, { gradientAngleToWind: sh.crestAngleToWind, coherence: sh.coherence });
}
// ---- direction: a north wind blows toward +y (south) ----
{
  const h0 = await sandSheet('Utah desert');
  sim.setWind({ from: 0, speed: 1.2, steady: 1 });
  await e.run(250 * 365);
  const g1 = await anomaly(h0);
  await e.run(50 * 365);
  const g2 = await anomaly(h0), d = [0, 1];
  const sh = shape(g2, e.N, d), mv = travel(g1, g2, e.N, d);
  R.runs.north = { ...sh, travelCells50yr: mv };
  check('directionDial', sh.crestAngleToWind < 25 && mv >= 1, { gradientAngleToWind: sh.crestAngleToWind, travelSouthCells: mv });
}
// ---- protected surfaces ----
{
  const out = {};
  let h0 = await sandSheet('Pacific NW wet');
  sim.setWind({ from: 270, speed: 1.2, steady: 1 });
  await e.run(100 * 365);
  out.wetGreen = shape(await anomaly(h0), e.N, [1, 0]).relief;
  h0 = await sandSheet('Utah desert', { capGravel: 0.05 });
  sim.setWind({ from: 270, speed: 1.2, steady: 1 });
  await e.run(100 * 365);
  const g = await anomaly(h0);
  let moved = 0; for (let y = 8; y < e.N - 8; y++) for (let x = 8; x < e.N - 8; x++) moved += Math.abs(g[y * e.N + x]);
  out.pavementMeanChange_m = moved / (e.N - 16) ** 2;
  out.pavementRelief = shape(g, e.N, [1, 0]).relief;
  R.runs.protected = out;
  check('protectedSurfaces', out.wetGreen < 1 && out.pavementRelief < 1, out);
}
// ---- sandblasting: sand streaming across bare layered rock ----
{
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Utah desert' }); sim.pause();
  e.strata = true;
  const N = e.N, q = e.device.queue, B = e.world.buffers;
  const bt = sim.strataBeds, top = sim.engine.strataInfo;
  // a plate sloping gently across the wind (y) through several beds; a sand supply strip upwind
  const h = await layer('initHeight');
  let mean = 0; for (const v of h) mean += v; mean /= h.length;
  const br = new Float32Array(N * N), so = new Float32Array(N * N), h0 = new Float32Array(N * N), dep = new Float32Array(N * N * 16);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    br[i] = mean + 60 - 0.5 * y - 0.01 * x;
    so[i] = x < 24 ? 6 : 0; h0[i] = br[i] + so[i];
    if (so[i] > 0) { dep[16 * i] = so[i]; dep[16 * i + 8] = 0.99 * 0.62; }
  }
  q.writeBuffer(B.bedrock, 0, br); q.writeBuffer(B.soil, 0, so); q.writeBuffer(B.initHeight, 0, h0); q.writeBuffer(B.deposit, 0, dep);
  q.writeBuffer(B.veg, 0, new Float32Array(N * N));
  sim.setWind({ from: 270, speed: 1.4, steady: 1 });
  await e.run(200 * 365);
  const b = await layer('bedrock');
  const wear = { hard: [], soft: [] };
  for (let y = 10; y < N - 10; y++) for (let x = 40; x < 200; x++) {
    const i = y * N + x, k = sim.strataLayer(br[i], x, y);
    wear[bt[k].hard ? 'hard' : 'soft'].push(br[i] - b[i]);
  }
  const m = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
  R.runs.abrasion = { hard_m: m(wear.hard), soft_m: m(wear.soft), cells: { hard: wear.hard.length, soft: wear.soft.length }, stack: top?.describe };
  check('sandblastingDifferential', m(wear.soft) > 1.3 * m(wear.hard) && m(wear.hard) > 0, R.runs.abrasion);
}
// ---- drifting snow, alpine ----
{
  const res = {};
  for (const on of [true, false]) {
    sim.pause(); await sim.load('random', { size: 256, seed: 7, preset: 'Colorado alpine' }); sim.pause();
    sim.setWind({ on, from: 270, speed: 1.2, steady: 1 });
    await e.run(3 * 365 + 60, { batchDays: 2 });
    const s = await sim.stats();
    res[on ? 'on' : 'off'] = { swe: await layer('snowSWE'), bal: s.balanceErrorPct, nan: s.hasNaN, snow_m3: s.totalSnowSWE_m3 };
    // shelter and wind speed from the wind-on run (the field is stored by its last batch)
    if (on) res.field = await layer('wind');
  }
  sim.setWind({ on: true });
  const w = res.field, N = e.N;
  let leeOn = 0, leeOff = 0, expOn = 0, expOff = 0, nl = 0, ne = 0;
  for (let i = 0; i < N * N; i++) {
    if (w[4 * i + 3] < 0.3) { leeOn += res.on.swe[i]; leeOff += res.off.swe[i]; nl++; }
    else if (w[4 * i + 2] > 1.3) { expOn += res.on.swe[i]; expOff += res.off.swe[i]; ne++; }
  }
  R.runs.snow = { leeGain: leeOn / Math.max(leeOff, 1e-9), exposedLoss: expOn / Math.max(expOff, 1e-9), leeCells: nl, exposedCells: ne, balOn: res.on.bal, snowOn_m3: res.on.snow_m3, snowOff_m3: res.off.snow_m3 };
  check('snowDrifts', R.runs.snow.leeGain > 1.15 && R.runs.snow.exposedLoss < 0.9, R.runs.snow);
  check('booksSnow', !res.on.nan && Math.abs(res.on.bal) < 0.01, { balPct: res.on.bal });
}
// ---- books on a real landscape ----
{
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Utah desert' }); sim.pause();
  sim.setWind({ on: true });
  await e.run(1000 * 365);
  const s = await sim.stats();
  const ws = await sim.windStats();
  R.runs.utah1000 = { solidsError_m3: s.solidsError_m3, sedOut_m3: s.cumSedimentOut_m3, balPct: s.balanceErrorPct, nan: s.hasNaN, maxErosion_m: s.maxErosion_m, ...ws };
  check('booksLandscape', !s.hasNaN && Math.abs(s.solidsError_m3) < 1e-3 * s.cumSedimentOut_m3 + 1000 && Math.abs(s.balanceErrorPct) < 0.01, R.runs.utah1000);
}
R.passed = Object.values(R.checks).filter((c) => c.pass).length;
R.total = Object.keys(R.checks).length;
R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
return R;
