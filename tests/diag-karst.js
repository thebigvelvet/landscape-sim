// Diagnostic: karst growth on a Valley and Ridge map. Reports dissolved depth and sunk water.
const e = sim.engine; const R = {};
sim.pause(); await sim.load('random', { size: 256, seed: window.__seed ?? 3, preset: 'Temperate', province: window.__prov ?? 'valleyRidge', volcanoes: false }); sim.pause();
R.province = e.provinceUsed; R.anoms = e.strataInfo.anoms.map((a) => a.type + (a.kind ? ':' + a.kind : ''));
R.notes = e.strataInfo.notes;
const N = e.N;
const b0 = await e.readLayer('bedrock');
for (const yrs of [100, 1000, 5000, 10000, 20000]) {
  const done = R.last || 0;
  await e.run((yrs - done) * 365);
  R.last = yrs;
  const k = await e.readLayer('karst'); const b = await e.readLayer('bedrock'); const s = await sim.stats();
  let mx = 0, sum = 0, n2 = 0, sk = 0, skm = 0, low = 0;
  for (let i = 0; i < N * N; i++) { const v = k[4 * i]; mx = Math.max(mx, v); sum += v; if (v > 2) n2++; sk += k[4 * i + 1]; skm = Math.max(skm, k[4 * i + 1]); low = Math.max(low, b0[i] - b[i]); }
  R['y' + yrs] = { maxDiss: +mx.toFixed(2), meanDiss: +(sum / N / N).toFixed(3), cellsOver2m: n2, maxLower: +low.toFixed(1), bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, sedOut: s.cumSedimentOut_m3, nan: s.hasNaN };
}
R.gpuErrors = window.__gpuErrors || 0; R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
return R;
