// Intrusive igneous rock (sim/strata.js: stocks, batholiths, sills, dike swarms, plugs). Run on the GPU:
//   node scripts/launch.cjs --eval=tests/intrusions.js --out=tests/out-intrusions.js.json
// Checks (placement over seeds 1-16 of each province, from the rock tables alone):
//   rockiesStocks     most Southern Rockies maps get a granite batholith or porphyry stock; no other
//                     province does
//   batholithBare     a batholith's crown is at or near the surface (it is what the range is cut into)
//   sillsByLaccoliths sills only on the Colorado Plateau, each fanning out from a laccolith
//   swarmAcrossFolds  Valley and Ridge dike swarms run across the fold axes (at least 50 degrees off)
//   gulfPlugsBuried   Gulf Coastal Plain plugs start buried
// Twin runs (the intrusion switched off in the rock table for the twin):
//   standsUp          a Valley and Ridge plug and dike swarm in soft rock stand above the same ground
//                     in the twin after 20 thousand years
//   stockHard         a Rockies stock (granite in a hornfels ring) wears down less than the twin
//   books             water and solids balance
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const t0 = performance.now();
const booksOk = (s) => !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1e-3 * (s.cumErupted_m3 + s.cumSedimentOut_m3) + 2000;
const books = [];
const N = 256;
const TB_ANOMS = 75;

// ---- placement ----
const P = {};
for (const prov of ['plateau', 'rockies', 'valleyRidge', 'gulf']) {
  P[prov] = [];
  for (let seed = 1; seed <= 16; seed++) {
    await sim.load('random', { size: N, seed, province: prov, volcanoes: false, spinUp: false });
    const T = e.strataInfo;
    P[prov].push({ seed, anoms: T.anoms.map((a) => ({ ...a })), domes: T.struct.domes.map((d) => ({ ...d })), fold: [T.struct.foldKx, T.struct.foldKy], beds: T.beds.map((b) => b.type + b.thick.toFixed(3)).join(',') });
  }
}
const has = (prov, f) => P[prov].filter((m) => m.anoms.some(f)).length;
const stockMaps = has('rockies', (a) => a.type === 'stock');
check('rockiesStocks', stockMaps >= 8 && ['plateau', 'valleyRidge', 'gulf'].every((p) => has(p, (a) => a.type === 'stock') === 0), { rockiesMapsWithStock: stockMaps, of: 16 });
const baths = P.rockies.flatMap((m) => m.anoms.filter((a) => a.kind === 'batholith'));
check('batholithBare', baths.length > 0 && baths.every((a) => a.below <= 15), { below: baths.map((a) => Math.round(a.below)) });
{
  let ok = true, n = 0;
  for (const m of P.plateau) for (const a of m.anoms.filter((q) => q.type === 'sill')) {
    n++;
    const L = m.anoms.find((q) => q.type === 'laccolith' && Math.hypot(q.seg[0] - a.seg[0], q.seg[1] - a.seg[1]) < 3 * q.hw);
    if (!L) ok = false;
  }
  const elsewhere = ['rockies', 'valleyRidge', 'gulf'].reduce((s, p) => s + has(p, (q) => q.type === 'sill'), 0);
  check('sillsByLaccoliths', ok && n > 0 && elsewhere === 0, { sills: n, elsewhere });
}
{
  const angles = [];
  for (const m of P.valleyRidge) for (const a of m.anoms.filter((q) => q.kind === 'swarm')) {
    const crest = Math.atan2(m.fold[1], m.fold[0]) + Math.PI / 2, dir = Math.atan2(a.seg[3] - a.seg[1], a.seg[2] - a.seg[0]);
    let d = Math.abs(((dir - crest) % Math.PI + Math.PI) % Math.PI); d = Math.min(d, Math.PI - d);
    angles.push(Math.round(d * 180 / Math.PI));
  }
  check('swarmAcrossFolds', angles.length > 0 && angles.every((d) => d >= 50), { angles });
}
{
  const plugs = P.gulf.flatMap((m) => m.anoms.filter((a) => a.type === 'neck'));
  check('gulfPlugsBuried', plugs.length > 0 && plugs.every((a) => a.kind === 'buriedPlug' && a.below > 0), { below: plugs.map((a) => Math.round(a.below)) });
}
// ---- twin runs ----
async function twin(prov, seed, preset, pick, years) {
  const res = {};
  for (const on of [true, false]) {
    sim.pause(); await sim.load('random', { size: N, seed, preset, province: prov, volcanoes: false }); sim.pause();
    const T = e.strataInfo;
    const idx = T.anoms.map((a, k) => (pick(a) ? k : -1)).filter((k) => k >= 0);
    // switch them off in the GPU rock table (type 0 = no anomaly)
    if (!on) for (const k of idx) e.strataPack.table[(TB_ANOMS + 2 * k + 1) * 4 + 1] = 0;
    const [b0, s0] = await Promise.all(['bedrock', 'soil'].map((n) => e.readLayer(n)));
    await e.run(years * 365);
    const [b1, s1] = await Promise.all(['bedrock', 'soil'].map((n) => e.readLayer(n)));
    const st = await sim.stats();
    books.push({ run: `${prov} ${seed} ${on ? 'on' : 'off'}`, ok: booksOk(st), bal: st.balanceErrorPct, solids: st.solidsError_m3 });
    res[on ? 'on' : 'off'] = { G0: b0.map((v, i) => v + s0[i]), G1: b1.map((v, i) => v + s1[i]), T, idx };
  }
  // compare the footprints (cells well inside an intrusion) with the twin
  const T = res.on.T;
  let n = 0, d = 0, nAll = 0, dAll = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x, diff = res.on.G1[i] - res.off.G1[i];
    nAll++; dAll += diff;
    if (sim.anomalyAt(x, y, T).some((a) => pick(a) && a.w > 0.8)) { n++; d += diff; }
  }
  return { cells: n, higherThanTwin_m: n ? d / n : 0, mapMean_m: dAll / nAll, picked: res.on.idx.length };
}
// Valley and Ridge: seed with a dike swarm and/or a plug
let vrSeed = P.valleyRidge.find((m) => m.anoms.some((a) => a.kind === 'swarm' || a.kind === 'plug'));
if (vrSeed) {
  const r = await twin('valleyRidge', vrSeed.seed, 'Temperate', (a) => a.kind === 'swarm' || a.kind === 'plug', 20000);
  R.runs.vr = { seed: vrSeed.seed, ...r };
  check('standsUp', r.cells > 20 && r.higherThanTwin_m > 2 && r.higherThanTwin_m > r.mapMean_m + 2, R.runs.vr);
} else check('standsUp', false, { reason: 'no Valley and Ridge seed with a swarm or plug' });
const rkSeed = P.rockies.find((m) => m.anoms.some((a) => a.kind === 'stock'));
if (rkSeed) {
  const r = await twin('rockies', rkSeed.seed, 'Colorado alpine', (a) => a.kind === 'stock', 20000);
  R.runs.rockies = { seed: rkSeed.seed, ...r };
  check('stockHard', r.cells > 20 && r.higherThanTwin_m > 0.5, R.runs.rockies);
} else check('stockHard', false, { reason: 'no Rockies seed with a stock' });

check('books', books.every((q) => q.ok), { books });
R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
check('noGpuErrors', R.gpuErrors === 0, { errors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
return R;
