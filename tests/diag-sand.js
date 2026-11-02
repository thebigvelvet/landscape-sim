// How fast does wind-laid sand build up on a real landscape? Utah desert 512, seed 7, wind on vs off.
//   node scripts/launch.cjs --eval=tests/diag-sand.js --out=tests/out-diag-sand.json
// Per checkpoint: wind sand volume (top-bed grain ~0.62 in the stack), cells under >= 0.5 m of it,
// the deepest pile, gravel pavement cover, and soil volume left on the land.
const e = sim.engine, R = { runs: {} };
const years = window.__years || [10, 50, 150];
async function measure() {
  const so = await e.readLayer('soil'), dep = await e.readLayer('deposit');
  const N = e.N, A = e.world.cellSize ** 2;
  let sandV = 0, deep = 0, maxS = 0, lag = 0, soilV = 0, looseV = 0, gravV = 0;
  for (let i = 0; i < N * N; i++) {
    soilV += so[i];
    let s = 0;
    for (let k = 0; k < 8; k++) {
      const th = dep[16 * i + k], g = (dep[16 * i + 8 + k] % 1) / 0.99;
      if (th > 0 && g > 0.6 && g < 0.64) s += th;
      else if (th > 0 && g >= 0.45 && g <= 0.85) looseV += th;
      else if (th > 0 && g > 0.85) gravV += th;
    }
    sandV += s; if (s >= 0.5) deep++; maxS = Math.max(maxS, s);
    const g0 = (dep[16 * i + 8] % 1) / 0.99;
    if (dep[16 * i] >= 0.02 && g0 > 0.85) lag++;
  }
  return { sand_m3: Math.round(sandV * A), otherSandBeds_m3: Math.round(looseV * A), gravelBeds_m3: Math.round(gravV * A), deepFrac: +(deep / (N * N)).toFixed(4), maxSand_m: +maxS.toFixed(2), pavementFrac: +(lag / (N * N)).toFixed(4), meanSoil_m: +(soilV / (N * N)).toFixed(3) };
}
for (const on of (window.__onlyOn ? [true] : [true, false])) {
  sim.pause(); await sim.load('random', { size: 512, seed: 7, preset: 'Utah desert' }); sim.pause();
  e.windOn = on;
  const out = { start: await measure() };
  let done = 0;
  for (const y of years) { await sim.run(365 * (y - done), window.__batch ? { batchDays: window.__batch } : {}); done = y; out['yr' + y] = await measure(); }
  const s = await sim.stats(); out.solidsErr = s.solidsError_m3;
  R.runs[on ? 'windOn' : 'windOff'] = out;
}
return R;
