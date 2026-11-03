// Glaciers (sim/glacier.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/glacier.js --out=tests/out-glacier.json
// Colorado alpine, 256 x 256, seed 4 (peaks ~4040 m, valleys ~2970 m):
//   cold        at -6 C (snowline mid-slope) glaciers form, mostly high up and more on shaded north
//               faces than sunny south ones (at -8 C even the valley floors keep their snow)
//   flow        at -6 C the ice moves (tens of m/yr), and a good share of it lies bare at the end of
//               summer, below the snowline, where only ice flowing down from above keeps it alive
//   warm/normal at +4 C there is no ice at all; at today's temperature at most a few small patches
//   retreat     warming a glaciated map back to normal melts nearly all the ice
//   carving     over 3000 years at -8 C the ground under the ice is worn down more than in a twin run
//               with glaciers off, and the ice drops its rock as thicker soil around its edges
//   books       water and solids balance with glaciers, at the default time step and at 30-day batches,
//               and the two time steps give similar glaciers
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();

async function grow(T, years, { glaciers = true, batchDays } = {}) {
  sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' }); sim.pause();
  e.climate.tempOffset = T; e.glaciers = glaciers;
  const h0 = await layer('initHeight');
  await e.run(years * 365, batchDays ? { batchDays } : {});
  const s = await sim.stats();
  const [g, b, so, sw] = await Promise.all(['glacier', 'bedrock', 'soil', 'snowSWE'].map(layer));
  return { s, g, b, so, sw, h0, gs: await sim.glacierStats() };
}
const books = (s) => ({ balPct: s.balanceErrorPct, solidsError_m3: s.solidsError_m3, sedOut_m3: s.cumSedimentOut_m3, nan: s.hasNaN });
const booksOk = (s) => !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1e-3 * s.cumSedimentOut_m3 + 2000;

// ---- cold: where the ice forms ----
const cold = await grow(-6, 500);
{
  const N = e.N, { g, b, so, h0 } = cold;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < N * N; i++) { mn = Math.min(mn, h0[i]); mx = Math.max(mx, h0[i]); }
  const band = [0, 0, 0], bandN = [0, 0, 0];
  let north = 0, northN = 0, south = 0, southN = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x, k = Math.min(2, Math.floor((3 * (h0[i] - mn)) / (mx - mn)));
    const ice = g[4 * i] > 1 ? 1 : 0;
    band[k] += ice; bandN[k]++;
    const gy = (h0[i + N] - h0[i - N]) / 20;   // grid +y is south; ground falling to the south faces the sun
    if (gy > 0.3) { north += ice; northN++; } else if (gy < -0.3) { south += ice; southN++; }
  }
  const frac = band.map((v, k) => v / bandN[k]);
  const nf = north / northN, sf = south / southN;
  R.runs.cold = { cover: cold.gs.iceCoverFrac, byThird: frac, northFaces: nf, southFaces: sf, ...cold.gs, ...books(cold.s) };
  check('formsWhenCold', cold.gs.iceCoverFrac > 0.02 && frac[2] > 3 * frac[0] && frac[2] > frac[1], { cover: cold.gs.iceCoverFrac, byThird: frac });
  check('shadedFacesFavoured', nf > 1.2 * sf, { northFaces: nf, southFaces: sf });
}

// ---- flow: the ice moves, and much of it lies below the snowline, where bare ice melts every
// summer and only survives centuries because ice keeps flowing down to it ----
{
  const N = e.N;
  let iceCells = 0, fast = 0;
  for (let i = 0; i < N * N; i++) if (cold.g[4 * i] > 1) { iceCells++; if (cold.g[4 * i] > 5 && cold.g[4 * i + 2] > 5) fast++; }
  // on to the end of summer
  const doy = ((e.day % 365) + 365) % 365;
  await e.run((250 - doy + 365) % 365 || 365, { batchDays: 2 });
  const [g, sw] = await Promise.all(['glacier', 'snowSWE'].map(layer));
  let ice = 0, bare = 0;
  for (let i = 0; i < N * N; i++) if (g[4 * i] > 1) { ice++; if (sw[i] < 0.01) bare++; }
  R.runs.flow = { iceCells, movingCells: fast, bareIceShareEndOfSummer: bare / ice, maxSpeed: cold.gs.maxSpeed_m_per_yr };
  check('iceFlows', fast > 0.2 * iceCells && bare / ice > 0.2 && bare / ice < 0.9, R.runs.flow);
}

// ---- warm and normal ----
{
  const warm = await grow(4, 500);
  const normal = await grow(0, 500);
  R.runs.warm = { ...warm.gs, ...books(warm.s) };
  R.runs.normal = { ...normal.gs, ...books(normal.s) };
  check('noIceWhenWarm', warm.gs.iceVolume_m3 < 1, R.runs.warm);
  check('fewPatchesToday', normal.gs.iceCoverFrac < 0.01, R.runs.normal);
}

// ---- retreat: warm the glaciated map back to normal ----
{
  sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine' }); sim.pause();
  e.climate.tempOffset = -8; e.glaciers = true;
  await e.run(500 * 365);
  const a = await sim.glacierStats();
  e.climate.tempOffset = 0;
  await e.run(300 * 365);
  const z = await sim.glacierStats(), s = await sim.stats();
  R.runs.retreat = { before_m3: a.iceVolume_m3, after_m3: z.iceVolume_m3, ...books(s) };
  check('retreatsWhenWarmed', z.iceVolume_m3 < 0.1 * a.iceVolume_m3 && booksOk(s), R.runs.retreat);
}

// ---- carving and moraines: 3000 years at -8 C, glaciers on vs off ----
{
  const on = await grow(-8, 3000);
  const off = await grow(-8, 3000, { glaciers: false });
  const N = e.N;
  const ice = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) if (on.g[4 * i] > 5) ice[i] = 1;
  let dOn = 0, dOff = 0, n = 0, ringOn = 0, ringOff = 0, nr = 0;
  for (let y = 4; y < N - 4; y++) for (let x = 4; x < N - 4; x++) {
    const i = y * N + x;
    if (ice[i]) { dOn += on.b[i] - on.h0[i]; dOff += off.b[i] - off.h0[i]; n++; continue; }
    // ring just outside the ice: within 4 cells of it, on gentle ground (moraines sit below the ice)
    let near = false;
    for (let dy = -4; dy <= 4 && !near; dy++) for (let dx = -4; dx <= 4; dx++) if (ice[i + dy * N + dx]) { near = true; break; }
    if (near) { ringOn += on.so[i]; ringOff += off.so[i]; nr++; }
  }
  R.runs.carving = {
    iceCells: n, bedrockChangeUnderIce_on_m: dOn / n, bedrockChangeUnderIce_off_m: dOff / n,
    soilAroundIce_on_m: ringOn / nr, soilAroundIce_off_m: ringOff / nr, ...on.gs, on: books(on.s), off: books(off.s),
  };
  check('carvesItsBed', dOn / n < dOff / n - 1, R.runs.carving);
  check('leavesMoraines', ringOn / nr > ringOff / nr * 1.1, R.runs.carving);
  check('booksLongRun', booksOk(on.s), R.runs.carving.on);
}

// ---- books and time step ----
{
  const a = await grow(-8, 300);
  const b = await grow(-8, 300, { batchDays: 30 });
  R.runs.books = { default: { ...books(a.s), ice_m3: a.gs.iceVolume_m3, cover: a.gs.iceCoverFrac }, batch30: { ...books(b.s), ice_m3: b.gs.iceVolume_m3, cover: b.gs.iceCoverFrac } };
  const ratio = b.gs.iceVolume_m3 / a.gs.iceVolume_m3;
  R.runs.books.iceRatio = ratio;
  check('booksBalance', booksOk(a.s) && booksOk(b.s), R.runs.books);
  check('timeStepConsistent', ratio > 0.7 && ratio < 1.4 && Math.abs(b.gs.iceCoverFrac - a.gs.iceCoverFrac) < 0.3 * a.gs.iceCoverFrac, R.runs.books);
}

R.passed = Object.values(R.checks).filter((c) => c.pass).length;
R.total = Object.keys(R.checks).length;
R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
return R;
