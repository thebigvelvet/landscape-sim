// Sediment bed pictures (tools/review harness, --eval; returns PNG data URLs in out.shots).
//   window.__scene = 'desert' (default: random Utah landscape, seed window.__seed ?? 3, washes and fans),
//                    'valley' (temperate valley) or 'dam' (the valley dammed into a lake)
//   window.__years  sim years before the pictures (default 3000; 100 for the dam)
// Shots: the whole map, the same with the "Sediment beds" overlay, and a close-up of the block side
// where the thickest fill meets the map edge.
const e = sim.engine, r = sim.renderer, c = r.camera;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const grab = () => new Promise((res) => requestAnimationFrame(() => res(document.querySelector('canvas').toDataURL('image/png'))));
const scene = window.__scene || 'desert';
const yrs = window.__years ?? (scene === 'dam' ? 100 : 3000);
if (scene === 'desert') await sim.load('random', { size: 512, seed: window.__seed ?? 3, preset: 'Utah desert' });
else await sim.load('valley', { size: 512, seed: 1, preset: 'Temperate' });
sim.pause();
if (scene === 'dam') {
  const pts = [];
  for (let x = e.N * 0.22; x <= e.N * 0.78; x += 6) pts.push({ x, y: e.N * 0.4 });
  await sim.sculptStroke('raise', pts, { radius: 16, intensity: 2.8, dabs: 14 });
}
await sim.run(365 * yrs + 160);
e.lastClimate.precipRate_mm_per_day = 0;
r.cloud = 0;
const out = { scene, shots: {} };
const N = e.N, dep = await e.readLayer('deposit'), b = await e.readLayer('bedrock'), so = await e.readLayer('soil');
const thick = (i) => { let t = 0; for (let k = 0; k < 8; k++) t += dep[16 * i + k]; return t; };
// thickest fill on any edge (one cell in, the outermost row is held at base level)
let best = { t: -1 };
for (let k = 1; k < N - 1; k++) {
  for (const [x, y, yaw] of [[k, 1, Math.PI], [k, N - 2, 0], [1, k, -Math.PI / 2], [N - 2, k, Math.PI / 2]]) {
    const t = thick(y * N + x);
    if (t > best.t) best = { t, x, y, yaw };
  }
}
out.edge = best;
const home = { yaw: c.yaw, pitch: c.pitch, dist: c.dist, target: [...c.target] };
Object.assign(c, { ...home, target: [...home.target], dist: home.dist * 0.7 });
await sleep(1500); out.shots.overview = await grab();
sim.setOverlay(8); await sleep(1500); out.shots['overview-beds'] = await grab(); sim.setOverlay(0);
const [wx, wz] = r.gridToWorld(best.x, best.y);
const gi = best.y * N + best.x;
for (const [name, dist, pitch] of [['edge', 500, 0.18], ['edge-close', 160, 0.1]]) {
  Object.assign(c, { yaw: best.yaw, pitch, dist, target: [wx, (b[gi] + so[gi]) * r.vex, wz] });
  await sleep(1500); out.shots[name] = await grab();
}
const s = await sim.stats();
Object.assign(out, { day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, nan: s.hasNaN, beds: await sim.depositStats(), edgeBeds: await sim.bedsAt(best.x, best.y), gpuErrors: window.__gpuErrors || 0 });
return out;
