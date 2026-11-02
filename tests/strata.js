// Rock layers (sim/strata.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/strata.js --out=tests/out-strata.json
// The same random Utah landscape is eroded with rock layers on and off. With layers on, sandstone
// beds should hold steeper faces than shale beds and shale should wear down faster; with them off
// (the control) the same bed assignment should show no such contrast. The solids books stay closed.
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const layer = (n) => e.readLayer(n);
const t0 = performance.now();
const YEARS = 30000;
const pct = (a, q) => { if (!a.length) return 0; const s = Float64Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const mean = (a) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);

for (const on of [true, false]) {
  e.strata = on;
  sim.pause(); await sim.load('random', { size: 256, seed: 3, preset: 'Utah desert' });
  sim.pause();
  await e.run(YEARS * 365);
  const s = await sim.stats();
  const N = e.N, dx = e.world.cellSize;
  const b = await layer('bedrock'), so = await layer('soil'), h0 = await layer('initHeight');
  // beds are always assigned with the layered stack, so the control is compared on the same cells
  const slope = { hard: [], soft: [] }, lower = { hard: [], soft: [] };
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    let g = 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) g = Math.max(g, (b[i] - b[i + oy * N + ox]) / dx);
    const kNow = sim.strataLayer(b[i], x, y), k0 = sim.strataLayer(h0[i], x, y);
    if (so[i] < 0.3) slope[kNow % 2 === 0 ? 'hard' : 'soft'].push(g);       // bare rock faces
    lower[k0 % 2 === 0 ? 'hard' : 'soft'].push(h0[i] - (b[i] + so[i]));     // by starting bed
  }
  R.runs[on ? 'layers' : 'uniform'] = {
    slopeP90: { hard: pct(slope.hard, 0.9), soft: pct(slope.soft, 0.9) },
    meanLowering_m: { hard: mean(lower.hard), soft: mean(lower.soft) },
    maxErosion_m: s.maxErosion_m, solidsError_m3: s.solidsError_m3, balPct: s.balanceErrorPct, hasNaN: s.hasNaN,
    cells: { hardFaces: slope.hard.length, softFaces: slope.soft.length },
  };
}
e.strata = true;
const L = R.runs.layers, U = R.runs.uniform;
const slopeRatio = (r) => r.slopeP90.hard / Math.max(1e-6, r.slopeP90.soft);
// sandstone benches can gain on balance (shale debris settles on them), so compare differences
const lowerDiff = (r) => r.meanLowering_m.soft - r.meanLowering_m.hard;
check('sandstoneCliffs', slopeRatio(L) > 1.3 && slopeRatio(L) > 1.2 * slopeRatio(U), { layers: slopeRatio(L), uniform: slopeRatio(U) });
check('shaleWearsFaster', lowerDiff(L) > lowerDiff(U) + 0.5, { shaleMinusSandstone_m: { layers: lowerDiff(L), uniform: lowerDiff(U) } });
check('books', [L, U].every((r) => !r.hasNaN && Math.abs(r.balPct) < 0.01 && Math.abs(r.solidsError_m3) < 1000), { solidsError_m3: [L.solidsError_m3, U.solidsError_m3], balPct: [L.balPct, U.balPct] });
R.allPass = Object.values(R.checks).every((c) => c.pass);
R.failed = Object.entries(R.checks).filter(([, c]) => !c.pass).map(([k]) => k);
R.wallSeconds = (performance.now() - t0) / 1000;
return R;
