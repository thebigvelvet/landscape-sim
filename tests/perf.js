// Performance with everything on: 512^2 random terrain, Colorado, trees, a fire, a storm cloud,
// smoke; 8 s at 1 day/s and 8 s at 1000 yr/s. Reports fps and GPU times.
sim.pause(); await sim.load('random', { size: 512, seed: 5, preset: 'Colorado alpine' });
const e = sim.engine; const N = e.N; const out = {};
for (const [label, speed] of [['1 day/s', 1], ['1000 yr/s', 365000]]) {
  sim.setSpeed(speed); sim.play();
  sim.brush('wildfire', { x: N * 0.6, y: N * 0.6, radius: 20 });
  sim.brush('storm', { x: N * 0.45, y: N * 0.5, radius: 40, days: 30 });
  await new Promise((r) => setTimeout(r, 2000));
  const fps = [], sim_ = [], ren = [], sub = [];
  for (let k = 0; k < 12; k++) { await new Promise((r) => setTimeout(r, 500)); fps.push(e.fps); const g = sim.gpuTimes; sim_.push(g.simMs); ren.push(g.renderMs); sub.push(g.nSub); }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  out[label] = { fpsMin: Math.min(...fps), fpsAvg: avg(fps), simMs: avg(sim_), renderMs: avg(ren), nSub: avg(sub) };
}
sim.pause();
const s = await sim.stats();
out.nan = s.hasNaN; out.bal = s.balanceErrorPct; out.gpuErrors = window.__gpuErrors || 0;
return out;
