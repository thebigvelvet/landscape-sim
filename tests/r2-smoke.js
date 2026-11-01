// Quick smoke test: plants spin up, run a while, no NaN, balance closes.
const out = {};
const errs0 = window.__gpuErrors || 0;
await sim.load('random', { size: 256, seed: 3, preset: 'Colorado alpine' }); sim.pause();
out.start = await sim.stats();
await sim.run(365 * 20);
out.after20y = await sim.stats();
const v = await sim.engine.readLayer('veg');
let mn = 1, mx = 0; for (const x of v) { mn = Math.min(mn, x); mx = Math.max(mx, x); }
out.vegRange = [mn, mx];
const c = await sim.engine.readLayer('clim');
const n = c.length / 4; let wi = 0, lg = 0, tg = 0;
for (let i = 0; i < n; i++) { wi += c[4*i+1] > 0 ? c[4*i] / c[4*i+1] : 0; lg += c[4*i+2] * 365; tg += c[4*i+2] > 1e-4 ? c[4*i+3] / c[4*i+2] : 0; }
out.climMean = { Wi: wi / n, Lgs: lg / n, Tgs: tg / n };
out.gpuErrors = (window.__gpuErrors || 0) - errs0; out.gpuErrorMsgs = window.__gpuErrorMsgs;
const pick = (s) => ({ bal: s.balanceErrorPct, nan: s.hasNaN, meanVeg: s.meanVeg, cov: s.vegCoveredFrac, burned: s.burnedFrac, gw: s.totalGroundwater_m3 });
out.start = pick(out.start); out.after20y = pick(out.after20y);
return out;
