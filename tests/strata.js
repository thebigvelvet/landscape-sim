// Rock layers (sim/strata.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/strata.js --out=tests/out-strata.json
// First the stack generator is checked over 200 seeds: beds of irregular thickness, gentle dips,
// monoclines in about a third of landscapes, and a stack deep enough for the whole map.
// Then the same random Utah landscape is eroded with rock layers on and off. With layers on, hard
// beds should hold steeper faces than soft beds and soft beds should wear down faster; with them
// off (the control) the same bed assignment should show no such contrast. The books stay closed.
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();
const YEARS = 30000;
const pct = (a, q) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

// ---- generator statistics over 200 seeds, on one real starting terrain ----
sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Utah desert' }); sim.pause();
{
  const N = e.N, dx = e.world.cellSize, h = await layer('initHeight');
  const G = { cv: [], samePairs: 0, pairs: 0, dips: [], mono: 0, monoDeg: [], fold: 0, covered: 0, beds: [] };
  for (let seed = 1; seed <= 200; seed++) {
    const T = sim.makeStrata(seed, h, N, dx, 1);
    const th = T.beds.slice(0, -1).map((b) => b.thick);
    const m = mean(th);
    G.cv.push(Math.sqrt(mean(th.map((t) => (t - m) ** 2))) / m);
    for (let k = 1; k < th.length; k++) { G.pairs++; if (Math.abs(th[k] - th[k - 1]) < 0.05 * Math.max(th[k], th[k - 1])) G.samePairs++; }
    G.dips.push(T.struct.dipDeg); G.beds.push(th.length);
    if (T.struct.monoThrow > 0) { G.mono++; G.monoDeg.push(T.struct.monoDeg); }
    if (T.struct.foldA !== 0) G.fold++;
    // the basement must not show anywhere at the start: every cell sits in a real bed
    let ok = true;
    for (let y = 0; y < N && ok; y += 8) for (let x = 0; x < N; x += 8) if (sim.strataLayer(h[y * N + x], x, y, T) === T.beds.length - 1) { ok = false; break; }
    if (ok) G.covered++;
  }
  const monoSteep = G.monoDeg.every((d) => d >= 10 && d <= 50);
  R.generator = { medianCV: pct(G.cv, 0.5), minCV: pct(G.cv, 0), samePairFrac: G.samePairs / G.pairs, dipRange: [pct(G.dips, 0), pct(G.dips, 1)],
    monoclineFrac: G.mono / 200, foldFrac: G.fold / 200, coveredFrac: G.covered / 200, bedsRange: [pct(G.beds, 0), pct(G.beds, 1)],
    thisLandscape: sim.engine.strataInfo.describe };
  check('irregularThickness', pct(G.cv, 0.5) > 0.5 && G.samePairs / G.pairs < 0.1, { medianCV: pct(G.cv, 0.5), samePairFrac: G.samePairs / G.pairs });
  check('gentleDips', G.dips.every((d) => d >= 0.3 && d <= 4), { range: R.generator.dipRange });
  check('monoclines', G.mono / 200 > 0.22 && G.mono / 200 < 0.48 && monoSteep, { frac: G.mono / 200, steepLimb: [pct(G.monoDeg, 0), pct(G.monoDeg, 1)] });
  check('stackDeepEnough', G.covered / 200 >= 0.98, { frac: G.covered / 200 });
}

for (const on of [true, false]) {
  e.strata = on;
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Utah desert' });
  sim.pause();
  await e.run(YEARS * 365);
  const s = await sim.stats();
  const N = e.N, dx = e.world.cellSize;
  const b = await layer('bedrock'), so = await layer('soil'), h0 = await layer('initHeight');
  const beds = sim.strataBeds;
  // beds are always assigned with the layered stack, so the control is compared on the same cells
  const slope = { hard: [], soft: [] }, lower = { hard: [], soft: [] };
  const rockLow = new Float32Array(N * N);   // bedrock lowering per cell (soil made from rock counts)
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    let g = 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g = Math.max(g, (b[i] - b[i + oy * N + ox]) / dx);
    const kNow = sim.strataLayer(b[i], x, y), k0 = sim.strataLayer(h0[i], x, y);
    if (so[i] < 0.3) slope[beds[kNow].hard ? 'hard' : 'soft'].push(g);       // bare rock faces
    lower[beds[k0].hard ? 'hard' : 'soft'].push(h0[i] - (b[i] + so[i]));     // by starting bed
    rockLow[i] = h0[i] - b[i];
  }
  R.runs[on ? 'layers' : 'uniform'] = {
    slopeP90: { hard: pct(slope.hard, 0.9), soft: pct(slope.soft, 0.9) },
    meanLowering_m: { hard: mean(lower.hard), soft: mean(lower.soft) },
    maxErosion_m: s.maxErosion_m, solidsError_m3: s.solidsError_m3, balPct: s.balanceErrorPct, hasNaN: s.hasNaN,
    cells: { hardFaces: slope.hard.length, softFaces: slope.soft.length },
  };
  R.runs[on ? 'layers' : 'uniform'].rockLow = rockLow;
}
e.strata = true;
const L = R.runs.layers, U = R.runs.uniform;
// each cell against itself with uniform rock: how much more bedrock did layers take, by starting bed
{
  const N = e.N, h0 = await layer('initHeight'), beds = sim.strataBeds, d = { hard: [], soft: [] };
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    d[beds[sim.strataLayer(h0[i], x, y)].hard ? 'hard' : 'soft'].push(L.rockLow[i] - U.rockLow[i]);
  }
  R.extraRockLowering_m = { hard: mean(d.hard), soft: mean(d.soft) };
  delete L.rockLow; delete U.rockLow;
}
const slopeRatio = (r) => r.slopeP90.hard / Math.max(1e-6, r.slopeP90.soft);
// sandstone benches can gain on balance (shale debris settles on them), so compare differences
const lowerDiff = (r) => r.meanLowering_m.soft - r.meanLowering_m.hard;
check('sandstoneCliffs', slopeRatio(L) > 1.3 && slopeRatio(L) > 1.2 * slopeRatio(U), { layers: slopeRatio(L), uniform: slopeRatio(U) });
check('shaleWearsFaster', R.extraRockLowering_m.soft > R.extraRockLowering_m.hard + 0.5, { extraRockLowering_m: R.extraRockLowering_m, totalShaleMinusSandstone_m: { layers: lowerDiff(L), uniform: lowerDiff(U) } });
check('books', [L, U].every((r) => !r.hasNaN && Math.abs(r.balPct) < 0.01 && Math.abs(r.solidsError_m3) < 1000), { solidsError_m3: [L.solidsError_m3, U.solidsError_m3], balPct: [L.balPct, U.balPct] });
R.allPass = Object.values(R.checks).every((c) => c.pass);
R.failed = Object.entries(R.checks).filter(([, c]) => !c.pass).map(([k]) => k);
R.wallSeconds = (performance.now() - t0) / 1000;
return R;
