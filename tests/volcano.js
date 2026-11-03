// Volcanoes (sim/volcano.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/volcano.js --out=tests/out-volcano.json
// The default eruption opens a vent on the side of a valley ('valley' scenario, 256 x 256, relief
// 0.6, so the lava has somewhere to go):
//   cone       a cinder cone near its planned height with a crater, flanks no steeper than the
//              cinders' angle of repose (plus the hillside it sits on)
//   flow       the lava runs down into the valley and along it, filling the valley floor (~10 m, as
//              valley-confined flows are) but never piling into a mound near the vent,
//              and has all set into basalt a few years after the eruption ends
//   plants     nothing grows under fresh lava; plants at its edges burn
//   books      water and solids balance with the erupted volume, at 2-day and 30-day batches
//   ice        an eruption under a glacier melts the ice around it and the water books still balance
//   hardness   twin runs over 20,000 years: basalt wears down less than the same ground made of the
//              plateau rock, and the cinder cone's top wears down faster than the same cone made of
//              basalt (the cinders crumble into a thick loose mantle that creeps off the cone)
//   fertility  plants on soil over volcanic rock grow back thicker than on the same soil elsewhere
//   maps       about a third of random maps start with old volcanoes (plug in the throat, basalt
//              flows); maps without one are exactly the same as before
const e = sim.engine, V = e.volcanoes;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();
const books = (s) => ({ balPct: s.balanceErrorPct, solidsError_m3: s.solidsError_m3, erupted_m3: s.cumErupted_m3, sedOut_m3: s.cumSedimentOut_m3, nan: s.hasNaN });
const booksOk = (s) => !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1e-3 * (s.cumErupted_m3 + s.cumSedimentOut_m3) + 2000;
const typeAt = (vr, i, z) => sim.volcLayer(vr, i % e.N, Math.floor(i / e.N), z);

async function valley(opts = {}) {
  sim.pause(); await sim.load('valley', { size: 256, seed: 3, relief: 0.6, preset: opts.preset || 'Colorado alpine', volcanoes: false }); sim.pause();
}
// erupt at (x, y) and run until the eruption is over and the lava has set (or maxDays)
async function erupt(x, y, { batchDays = 2, maxDays = 20000, after } = {}) {
  const ev = sim.brush('volcano', { x, y }); await ev.ready;
  const startDay = e.day;
  if (after) { await e.run(after.days, { batchDays }); await after.fn(); }
  while (e.day - startDay < maxDays) {
    await e.run(30, { batchDays });
    const s = await sim.stats();
    if (!s.erupting && s.hotLavaCells === 0) break;
  }
  return { ev, days: e.day - startDay };
}
const VX = 128 + 25, VY = 184;

// ---- the default eruption on a valley side ----
await valley();
const h0 = await layer('initHeight');
const plants = {};
const A = await erupt(VX, VY, {
  after: { days: 60, fn: async () => {
    const [lv, veg, burn, pl] = await Promise.all(['lava', 'veg', 'burn', 'plant'].map(layer));
    const N = e.N; let under = 0, underVeg = 0, edge = 0, edgeHit = 0;
    for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
      const i = y * N + x;
      if (lv[4 * i] > 0.3 && lv[4 * i + 1] > 0.15) { under++; underVeg += veg[i]; continue; }
      if (lv[4 * i] > 0.05) continue;
      let near = false;
      for (let d = 0; d < 4 && !near; d++) { const j = i + [1, -1, N, -N][d]; if (lv[4 * j] > 0.3 && lv[4 * j + 1] > 0.15) near = true; }
      if (near) { edge++; if (burn[i] > 0.05 || pl[4 * i + 3] > 0.05 || veg[i] < 0.03) edgeHit++; }
    }
    Object.assign(plants, { lavaCells: under, meanVegUnderLava: underVeg / Math.max(1, under), edgeCells: edge, edgeBurnedOrBare: edgeHit / Math.max(1, edge) });
  } },
});
{
  const s = await sim.stats(), vs = await sim.volcanoStats();
  const [b, so, vr] = await Promise.all(['bedrock', 'soil', 'volcRock'].map(layer));
  const N = e.N, H = A.ev.coneHeight;
  // cone: height above the old ground, crater, flank slope
  let peak = 0, maxSlope = 0;
  const dz = (i) => b[i] + so[i] - h0[i];
  for (let y = VY - 30; y <= VY + 30; y++) for (let x = VX - 30; x <= VX + 30; x++) {
    const i = y * N + x, r = Math.hypot(x - VX, y - VY);
    peak = Math.max(peak, dz(i));
    if (r > 4 && dz(i) > 0.3 * H && typeAt(vr, i, b[i] - 0.01) === 2) {
      const g = Math.hypot((b[i + 1] + so[i + 1] - b[i - 1] - so[i - 1]) / 20, (b[i + N] + so[i + N] - b[i - N] - so[i - N]) / 20);
      const g0 = Math.hypot((h0[i + 1] - h0[i - 1]) / 20, (h0[i + N] - h0[i - N]) / 20);
      maxSlope = Math.max(maxSlope, g - g0);    // steepness the cone adds to the hillside
    }
  }
  const crater = dz(VY * N + VX);
  R.runs.cone = { plannedHeight_m: H, peak_m: peak, craterFloor_m: crater, maxAddedSlope: maxSlope, days: A.days };
  check('coneForms', peak > 0.75 * H && peak < 1.2 * H && crater < peak - 0.08 * H && maxSlope < 0.75, R.runs.cone);
  // flow: basalt cells, where they went, how thick
  let n = 0, sx = 0, sy = 0, x0 = N, x1 = 0, y0 = N, y1 = 0, th = 0, thMax = 0;
  for (let i = 0; i < N * N; i++) {
    if (typeAt(vr, i, b[i] - 0.01) !== 1) continue;
    const x = i % N, y = Math.floor(i / N);
    n++; sx += x; sy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    th += dz(i); thMax = Math.max(thMax, dz(i));
  }
  const src = vs.vents[0]?.source;
  R.runs.flow = { basaltCells: n, centroid: [sx / n, sy / n], source: src, alongValley_cells: y1 - y0, across_cells: x1 - x0, meanThick_m: th / n, maxThick_m: thMax, basalt_m3: vs.basalt_m3, cinders_m3: vs.cinders_m3, plug_m3: vs.plug_m3, moltenLeft_m3: vs.moltenLava_m3 };
  check('lavaRunsDownValley', n > 300 && sy / n < src.y - 15 && y1 - y0 > 1.5 * (x1 - x0) && sx / n < src.x, R.runs.flow);
  check('lavaIsAFlowNotAMound', th / n > 1 && th / n < 20 && thMax < 0.6 * H, R.runs.flow);
  check('lavaSets', vs.moltenLava_m3 < 1000 && A.days < 3 * 365 + A.ev.days * 3, { days: A.days, molten_m3: vs.moltenLava_m3 });
  R.runs.plants = plants;
  check('plantsBurn', plants.lavaCells > 50 && plants.meanVegUnderLava < 0.01 && plants.edgeBurnedOrBare > 0.5, plants);
  R.runs.books2 = books(s);
  check('books2day', booksOk(s) && Math.abs(s.cumErupted_m3 - (A.ev.cinders + A.ev.lava)) < 0.25 * (A.ev.cinders + A.ev.lava), R.runs.books2);
}

// ---- the same eruption at 30-day batches: same books, a similar flow ----
{
  await valley();
  const B = await erupt(VX, VY, { batchDays: 30 });
  const s = await sim.stats(), vs = await sim.volcanoStats();
  R.runs.books30 = { ...books(s), basalt_m3: vs.basalt_m3, days: B.days };
  check('books30day', booksOk(s) && Math.abs(vs.basalt_m3 - R.runs.flow.basalt_m3) < 0.25 * R.runs.flow.basalt_m3, R.runs.books30);
}

// ---- hardness twins: 20,000 years after the eruption ----
async function twin(edit) {
  await valley();
  await erupt(VX, VY);
  const vr = await layer('volcRock'), b = await layer('bedrock');
  const types = new Int8Array(e.N * e.N);
  let peak0 = 0;
  for (let i = 0; i < e.N * e.N; i++) types[i] = typeAt(vr, i, b[i] - 0.01);
  if (edit) { edit(vr); e.device.queue.writeBuffer(e.world.buffers.volcRock, 0, vr); }
  const z0 = (await layer('bedrock')).map((v, i) => v + 0);
  const so0 = await layer('soil');
  for (let i = 0; i < e.N * e.N; i++) if (types[i] === 2) peak0 = Math.max(peak0, z0[i] + so0[i]);
  await e.run(20000 * 365);
  const [b1, so1] = await Promise.all(['bedrock', 'soil'].map(layer));
  const low = { 1: [0, 0], 2: [0, 0] };
  let peak1 = 0;
  for (let i = 0; i < e.N * e.N; i++) {
    const t = types[i];
    if (t === 1 || t === 2) { low[t][0] += (z0[i] + so0[i]) - (b1[i] + so1[i]); low[t][1]++; }
    if (t === 2) peak1 = Math.max(peak1, b1[i] + so1[i]);
  }
  return { basaltLowered_m: low[1][0] / low[1][1], cindersLowered_m: low[2][0] / low[2][1], coneTopLowered_m: peak0 - peak1, s: await sim.stats() };
}
{
  const real = await twin(null);
  const plain = await twin((vr) => { for (let i = 0; i < vr.length; i += 8) vr.fill(0, i + 4, i + 8); });
  const allBasalt = await twin((vr) => { for (let i = 0; i < vr.length; i += 8) for (let k = 4; k < 8; k++) if (vr[i + k] === 2) vr[i + k] = 1; });
  R.runs.hardness = { real: { ...real, s: books(real.s) }, plateauRock: { ...plain, s: books(plain.s) }, coneOfBasalt: { ...allBasalt, s: books(allBasalt.s) } };
  check('basaltIsHard', real.basaltLowered_m < 0.7 * plain.basaltLowered_m, { real: real.basaltLowered_m, plateauRock: plain.basaltLowered_m });
  check('cindersWashAway', real.coneTopLowered_m > 2 * allBasalt.coneTopLowered_m && real.cindersLowered_m > allBasalt.cindersLowered_m, { coneTop_real: real.coneTopLowered_m, coneTop_basalt: allBasalt.coneTopLowered_m, mean_real: real.cindersLowered_m, mean_basalt: allBasalt.cindersLowered_m });
  check('booksLongRun', booksOk(real.s), R.runs.hardness.real.s);
}

// ---- an eruption under a glacier ----
{
  async function cold(withVolcano) {
    sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine', volcanoes: false }); sim.pause();
    e.climate.tempOffset = -8; e.glaciers = true;
    await e.run(400 * 365);
    const g = await layer('glacier');
    // the vent: the thickest ice not too near the edge
    let best = -1, vx = 0, vy = 0;
    for (let y = 40; y < e.N - 40; y++) for (let x = 40; x < e.N - 40; x++) { const H = g[4 * (y * e.N + x)]; if (H > best) { best = H; vx = x; vy = y; } }
    const disc = (gg) => { let v = 0; for (let y = vy - 40; y <= vy + 40; y++) for (let x = vx - 40; x <= vx + 40; x++) v += gg[4 * (y * e.N + x)]; return v * 100; };
    const before = disc(g);
    if (withVolcano) await erupt(vx, vy, { batchDays: 2, maxDays: 3 * 365 });
    else await e.run(2 * 365, { batchDays: 2 });
    const g1 = await layer('glacier');
    return { vent: [vx, vy], ice0: best, iceNear_before_m3: before, iceNear_after_m3: disc(g1), s: await sim.stats(), days: e.day };
  }
  const hot = await cold(true), still = await cold(false);
  R.runs.ice = { eruption: { ...hot, s: books(hot.s) }, noEruption: { ...still, s: books(still.s) } };
  const lostHot = hot.iceNear_before_m3 - hot.iceNear_after_m3, lostStill = still.iceNear_before_m3 - still.iceNear_after_m3;
  check('meltsIce', lostHot > lostStill + 1e6, { lostWithEruption_m3: lostHot, lostWithout_m3: lostStill });
  check('booksWithIce', booksOk(hot.s), R.runs.ice.eruption.s);
}

// ---- fertility: the same soil over volcanic rock and over the plateau rock ----
{
  async function patch(volcanic) {
    await valley({ preset: 'Utah desert' });
    const [vr, b] = await Promise.all(['volcRock', 'bedrock'].map(layer));
    const N = e.N, cells = [];
    for (let y = 60; y < 200; y++) for (let x = 0; x < N; x++) {
      if (((x + y) >> 3) % 2) continue;                 // a checkerboard of 8-cell stripes, both halves alike
      const i = y * N + x;
      cells.push(i);
      if (volcanic) { vr[8 * i] = b[i] - 20; vr[8 * i + 4] = 1; }
    }
    e.device.queue.writeBuffer(e.world.buffers.volcRock, 0, vr);
    await e.run(60 * 365);
    const [veg, so] = await Promise.all(['veg', 'soil'].map(layer));
    let v = 0, s = 0, n = 0;
    for (const i of cells) if (so[i] > 0.25) { v += veg[i]; s += so[i]; n++; }
    return { meanVeg: v / n, meanSoil_m: s / n, cells: n };
  }
  const onBasalt = await patch(true), plainRock = await patch(false);
  R.runs.fertility = { onBasalt, plainRock };
  check('volcanicSoilIsFertile', onBasalt.meanVeg > 1.1 * plainRock.meanVeg, R.runs.fertility);
}

// ---- old volcanoes in generated maps ----
{
  let withV = 0, tried = 0, example = null;
  for (let seed = 1; seed <= 30; seed++) {
    sim.pause(); await sim.load('random', { size: 256, seed, volcanoes: true, spinUp: false }); sim.pause();
    tried++;
    if (e.volcanoInfo?.length) { withV++; if (!example) example = { seed, info: e.volcanoInfo, describe: e.strataInfo.describe }; }
  }
  R.runs.maps = { tried, withVolcanoes: withV, example };
  check('someMapsHaveVolcanoes', withV / tried > 0.15 && withV / tried < 0.6, R.runs.maps);
  // the example: plug in the throat, basalt flows, cinders on the cone
  sim.pause(); await sim.load('random', { size: 256, seed: example.seed, volcanoes: true }); sim.pause();
  const [vr, b] = await Promise.all(['volcRock', 'bedrock'].map(layer));
  const v0 = example.info[0], N = e.N;
  const counts = [0, 0, 0, 0];
  for (let i = 0; i < N * N; i++) counts[typeAt(vr, i, b[i] - 0.01)]++;
  const throat = typeAt(vr, Math.round(v0.y) * N + Math.round(v0.x), b[Math.round(v0.y) * N + Math.round(v0.x)] - 0.01);
  R.runs.maps.exampleCells = { plateau: counts[0], basalt: counts[1], cinders: counts[2], plug: counts[3], throat };
  check('oldVolcanoRocks', throat === 3 && counts[1] > 200 && counts[2] > 200, R.runs.maps.exampleCells);
  // a seed without volcanoes is the same map either way
  let plainSeed = 1; while (plainSeed < 30) { sim.pause(); await sim.load('random', { size: 256, seed: plainSeed, volcanoes: true, spinUp: false }); if (!e.volcanoInfo.length) break; plainSeed++; }
  const a = await layer('initHeight');
  sim.pause(); await sim.load('random', { size: 256, seed: plainSeed, volcanoes: false, spinUp: false }); sim.pause();
  const c = await layer('initHeight');
  let diff = 0; for (let i = 0; i < a.length; i++) diff = Math.max(diff, Math.abs(a[i] - c[i]));
  check('plainMapsUnchanged', diff === 0, { seed: plainSeed, maxDiff: diff });
}

R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
check('noGpuErrors', R.gpuErrors === 0, { errors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
return R;
