// Frame cost of the glaciers: Colorado alpine at -8 C grown for 1000 years so there is plenty of ice,
// then 8 s at 1 day/s and 8 s at 1000 yr/s with glaciers on or off (window.__glacOn) and the map size
// from window.__size (512 default). Harness: tests/shoot.sh <name> 'window.__glacOn=false' tests/perf-glacier.js
sim.pause(); await sim.load('random', { size: window.__size || 512, seed: 5, preset: 'Colorado alpine' }); sim.pause();
const e = sim.engine; const out = {};
e.climate.tempOffset = -8;
await sim.run(1000 * 365);
out.ice = await sim.glacierStats();
e.glaciers = window.__glacOn ?? true;
for (const [label, speed] of [['1 day/s', 1], ['1000 yr/s', 365000]]) {
  sim.setSpeed(speed); sim.play();
  await new Promise((r) => setTimeout(r, 2000));
  const fps = [], sim_ = [], ren = [], sub = [];
  for (let k = 0; k < 12; k++) { await new Promise((r) => setTimeout(r, 500)); fps.push(e.fps); const g = sim.gpuTimes; sim_.push(g.simMs); ren.push(g.renderMs); sub.push(g.nSub); }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  out[label] = { fpsMin: Math.min(...fps), fpsAvg: avg(fps), simMs: avg(sim_), renderMs: avg(ren), nSub: avg(sub), K: e.lastPlan.glacK };
}
sim.pause();
const s = await sim.stats();
out.nan = s.hasNaN; out.bal = s.balanceErrorPct; out.gpuErrors = window.__gpuErrors || 0;
return out;
