// Frame cost per province (window.__province; window.__strataOn=false for the layers-off baseline).
//   tests/shoot-data.sh is not needed: node scripts/launch.cjs --eval=<this with globals> --out=...
sim.pause(); await sim.load('random', { size: window.__size || 512, seed: 5, preset: 'Colorado alpine', province: window.__province || 'rockies' });
const e = sim.engine; e.strata = window.__strataOn ?? true; const out = { province: e.provinceUsed, anomalies: e.strataInfo.anoms.length };
for (const [label, speed] of [['1 day/s', 1], ['1000 yr/s', 365000]]) {
  sim.setSpeed(speed); sim.play();
  await new Promise((r) => setTimeout(r, 2000));
  const fps = [], sim_ = [], ren = [];
  for (let k = 0; k < 10; k++) { await new Promise((r) => setTimeout(r, 500)); fps.push(e.fps); const g = sim.gpuTimes; sim_.push(g.simMs); ren.push(g.renderMs); }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  out[label] = { fpsMin: Math.min(...fps), fpsAvg: avg(fps), simMs: avg(sim_), renderMs: avg(ren) };
}
sim.pause(); e.strata = true;
const s = await sim.stats(); out.nan = s.hasNaN; out.gpuErrors = window.__gpuErrors || 0;
return out;
