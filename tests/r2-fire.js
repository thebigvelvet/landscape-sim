// Wildfire: a burned patch erodes more than an identical unburned one, then plants recover.
// The cone is radially symmetric, so the east and west flanks at the same radius are identical
// (aspect only matters north-south). Burn the east patch, leave the west as the control, rain the
// same storm on both, and compare.
const R = {};
await sim.load('cone', { size: 256, seed: 1, preset: window.__preset || 'Temperate' }); sim.pause();
await sim.run(365 * 60, { batchDays: 365000 / 60 });     // let soil and plants settle
const E = sim.engine, N = E.world.N;
const c = (N - 1) / 2, r0 = Math.round(N * 0.24), rad = 12;
const A = { x: c + r0, y: c }, B = { x: c - r0, y: c };
const ground = async () => { const b = await E.readLayer('bedrock'), s = await E.readLayer('soil'); return b.map((v, i) => v + s[i]); };
const patch = async (P, r = rad) => ({
  veg: await circleMean(sim, 'veg', P.x, P.y, r), woody: await circleMean(sim, 'eco', P.x, P.y, r, 0),
  burn: await circleMean(sim, 'eco', P.x, P.y, r, 1), soil: await circleMean(sim, 'soil', P.x, P.y, r),
});
const lowering = (z0, z1, P, r = rad) => {
  let s = 0, n = 0;
  for (let y = Math.floor(P.y - r); y <= Math.ceil(P.y + r); y++) for (let x = Math.floor(P.x - r); x <= Math.ceil(P.x + r); x++) {
    if ((x - P.x) ** 2 + (y - P.y) ** 2 > r * r) continue;
    s += z0[y * N + x] - z1[y * N + x]; n++;
  }
  return s / n;
};
R.before = { burnedPatch: await patch(A), control: await patch(B) };
const s0 = await sim.stats();
R.fire = await sim.brush('wildfire', { x: A.x, y: A.y, radius: rad, intensity: 1 });
R.afterFire = { burnedPatch: await patch(A), control: await patch(B), stats: pickStats(await sim.stats()) };
// the same storm on both patches, then two years of ordinary weather at real-time-ish hydrology
const z0 = await ground();
await sim.brush('storm', { x: A.x, y: A.y, radius: 2 * rad, days: 3 });
await sim.brush('storm', { x: B.x, y: B.y, radius: 2 * rad, days: 3 });
await sim.run(5, { batchDays: 0.05, nSub: 64 });
const zS = await ground();
await sim.run(2 * 365, { batchDays: 2, nSub: 64 });
const z1 = await ground();
R.erosion = {
  stormLowering_m: { burned: lowering(z0, zS, A), control: lowering(z0, zS, B) },
  twoYearLowering_m: { burned: lowering(z0, z1, A), control: lowering(z0, z1, B) },
};
R.erosion.ratio2y = R.erosion.twoYearLowering_m.burned / Math.max(1e-9, R.erosion.twoYearLowering_m.control);
R.after2y = { burnedPatch: await patch(A), control: await patch(B), stats: pickStats(await sim.stats()) };
await sim.run(3 * 365, { batchDays: 10, nSub: 32 });
R.after5y = { burnedPatch: await patch(A), control: await patch(B), stats: pickStats(await sim.stats()) };
await sim.run(25 * 365, { batchDays: 365 / 2, nSub: 32 });
R.after30y = { burnedPatch: await patch(A), control: await patch(B) };
await sim.run(90 * 365, { batchDays: 365000 / 60 });
R.after120y = { burnedPatch: await patch(A), control: await patch(B), stats: pickStats(await sim.stats()) };
const s1 = await sim.stats();
R.balancePct = s1.balanceErrorPct; R.nan = s1.hasNaN; R.gpuErrors = window.__gpuErrors || 0;
// leave the scar in view for a screenshot: re-burn and show the plants overlay from above
if (window.__shot) {
  await sim.brush('wildfire', { x: A.x, y: A.y, radius: rad, intensity: 1 });
  await sim.run(400, { batchDays: 2, nSub: 64 });
  sim.renderer.camera.yaw = -1.2; sim.renderer.camera.pitch = 0.75; sim.renderer.camera.dist = 1700;
  sim.renderer.camera.target = [(A.x - c) * 10, 450, 0];
}
return R;
