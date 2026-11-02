// Round 6 pictures. Harness: tests/shoot.sh <name> 'window.__mode="desert"' tests/visual-wind.js
//   desert     random Utah desert after 500 years (window.__wind = false: wind off, the control)
//   overlay    the same, shown with the Wind & sand view
//   snow       rugged Colorado alpine in early March after 30 years: drifts in the lee of ridges
//   sea        a flat 4 m sand sheet after 400 years (window.__steady: 1 ridges, 0.5 linear, 0 star)
const e = sim.engine, c = sim.renderer.camera, mode = window.__mode || 'desert';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { mode };
e.windOn = window.__wind ?? true;
if (mode === 'desert' || mode === 'overlay') {
  await sim.load('random', { size: 512, seed: 7, preset: 'Utah desert' }); sim.pause();
  await sim.run(365 * 500 + 160);
  c.yaw = 0.6; c.pitch = 0.5; c.dist *= 0.6;
  if (mode === 'overlay') sim.setOverlay('wind');
} else if (mode === 'snow') {
  await sim.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' }); sim.pause();
  await sim.run(365 * 30 + 65);
  c.yaw = 0.3; c.pitch = 0.42; c.dist *= 0.55;
} else {
  await sim.load('random', { size: 256, seed: 5, preset: 'Utah desert' }); sim.pause();
  const N = e.N, q = e.device.queue, B = e.world.buffers;
  let rng = 99; const rnd = () => { rng = (rng * 1664525 + 1013904223) >>> 0; return rng / 4294967296; };
  const br = new Float32Array(N * N), so = new Float32Array(N * N), h0 = new Float32Array(N * N), dep = new Float32Array(N * N * 16);
  for (let i = 0; i < N * N; i++) {
    br[i] = 50 - 0.02 * (i % N); so[i] = 4 + 0.05 * (rnd() - 0.5); h0[i] = br[i] + so[i];
    dep[16 * i] = so[i]; dep[16 * i + 8] = 0.99 * 0.62;
  }
  q.writeBuffer(B.bedrock, 0, br); q.writeBuffer(B.soil, 0, so); q.writeBuffer(B.initHeight, 0, h0); q.writeBuffer(B.deposit, 0, dep);
  q.writeBuffer(B.veg, 0, new Float32Array(N * N));
  sim.setWind({ from: 270, speed: 1.2, steady: window.__steady ?? 1 });
  await sim.run(365 * 400);
  c.yaw = 0.6; c.pitch = 0.6; c.dist *= 0.75;
}
e.lastClimate.precipRate_mm_per_day = 0;
sim.renderer.cloud = 0;
await sleep(2500);
const s = await sim.stats();
Object.assign(out, { day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, nan: s.hasNaN, sedOut: s.cumSedimentOut_m3, wind: await sim.windStats(), gpuErrors: window.__gpuErrors || 0, gpuMsgs: window.__gpuErrorMsgs });
return out;
