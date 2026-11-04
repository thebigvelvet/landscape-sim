// Quick smoke run: every province loads, the shaders compile, 300 years run and the books close.
//   node scripts/launch.cjs --eval=tests/smoke-provinces.js --out=tests/out-smoke-provinces.json
const e = sim.engine;
const R = {};
for (const p of ['plateau', 'rockies', 'valleyRidge', 'gulf']) {
  sim.pause(); await sim.load('random', { size: 256, seed: 5, province: p, preset: 'Colorado alpine' }); sim.pause();
  await e.run(300 * 365);
  const s = await sim.stats();
  R[p] = { describe: e.strataInfo.describe, notes: e.strataInfo.notes, anoms: e.strataInfo.anoms.map((a) => a.type),
    beds: e.strataInfo.beds.map((b) => b.type), bal: s.balanceErrorPct, solids: s.solidsError_m3, nan: s.hasNaN, sedOut: s.cumSedimentOut_m3 };
}
R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
return R;
