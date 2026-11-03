// Frame cost of an eruption: a 512 valley map with an eruption going (window.__size), measured at
// 1 day/s and at 1000 yr/s, against the same map with nothing erupting.
//   node scripts/launch.cjs --eval=tests/perf-volcano.js --out=tests/out-perf-volcano.json
const e = sim.engine; const out = {};
const N = window.__size || 512, k = N / 256;
const measure = async (label, speed) => {
  sim.setSpeed(speed); sim.play();
  await new Promise((r) => setTimeout(r, 1500));
  const fps = [], sim_ = [], ren = [];
  for (let j = 0; j < 8; j++) { await new Promise((r) => setTimeout(r, 400)); fps.push(e.fps); const g = sim.gpuTimes; sim_.push(g.simMs); ren.push(g.renderMs); }
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  out[label] = { fpsMin: Math.min(...fps), fpsAvg: avg(fps), simMs: avg(sim_), renderMs: avg(ren), lavaK: e.lastPlan.lavaK, erupting: e.volcanoes.erupting };
  sim.pause();
};
for (const erupting of [false, true]) {
  for (const [label, speed] of [['1 day/s', 1], ['1000 yr/s', 365000]]) {
    sim.pause(); await sim.load('valley', { size: N, seed: 3, relief: 0.6, volcanoes: false }); sim.pause();
    if (erupting) { const ev = sim.brush('volcano', { x: (128 + 25) * k, y: 184 * k }); await ev.ready; await e.run(20, { batchDays: 1 }); }
    await measure(`${erupting ? 'erupting' : 'quiet'} ${label}`, speed);
  }
}
const s = await sim.stats();
out.nan = s.hasNaN; out.bal = s.balanceErrorPct; out.gpuErrors = window.__gpuErrors || 0;
return out;
