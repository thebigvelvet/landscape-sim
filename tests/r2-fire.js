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
await sim.run(2 * 365, { batchDays: 6, nSub: 64 });     // about 1 year per second
const z1 = await ground();
R.erosion = {
  stormLowering_m: { burned: lowering(z0, zS, A), control: lowering(z0, zS, B) },
  twoYearLowering_m: { burned: lowering(z0, z1, A), control: lowering(z0, z1, B) },
};
R.erosion.ratio2y = R.erosion.twoYearLowering_m.burned / Math.max(1e-9, R.erosion.twoYearLowering_m.control);
R.after2y = { burnedPatch: await patch(A), control: await patch(B), stats: pickStats(await sim.stats()) };
R.balanceAfterStormPct = (await sim.stats()).balanceErrorPct;
if (window.__part === 'erosion') return R;

// Part 2, recovery: a forest on deeper soil (random mountain range), fire but no extra storm,
// ordinary weather afterwards. A forested patch elsewhere at a similar elevation is the control.
await sim.load('random', { size: 256, seed: 5, preset: window.__recPreset || 'Colorado alpine' }); sim.pause();
await sim.run(365 * 200, { batchDays: 365000 / 60 });
{
  const so = await E.readLayer('soil'), ec = await E.readLayer('eco'), bd = await E.readLayer('bedrock');
  // stay out of the lowest quarter of the map: closed hollows there fill into lakes at slow speed
  const zs = Array.from(bd, (v, i) => v + so[i]).sort((p, q) => p - q), zLow = zs[Math.floor(zs.length * 0.25)];
  const cands = [];
  for (let y = 20; y < N - 20; y += 6) for (let x = 20; x < N - 20; x += 6) {
    let s = 0, t = 0, n = 0;
    for (let dy = -10; dy <= 10; dy++) for (let dx = -10; dx <= 10; dx++) { if (dx * dx + dy * dy > 100) continue; const i = (y + dy) * N + x + dx; s += so[i]; t += ec[4 * i]; n++; }
    if (bd[y * N + x] + so[y * N + x] > zLow) cands.push({ x, y, soil: s / n, woody: t / n });
  }
  const good = cands.filter((p) => p.soil > 0.5).sort((p, q) => q.woody - p.woody);
  A.x = good[0].x; A.y = good[0].y;
  const far = good.filter((p) => Math.hypot(p.x - A.x, p.y - A.y) > 60);
  B.x = far[0].x; B.y = far[0].y;
}
// burn in midsummer (snow-covered fuel does not burn)
await sim.run(((200 - (E.day % 365)) + 365) % 365, { batchDays: 5, nSub: 32 });
R.recovery = { site: { burned: { ...A }, control: { ...B } }, before: { burned: await patch(A, 10), control: await patch(B, 10) } };
R.recovery.fire = await sim.brush('wildfire', { x: A.x, y: A.y, radius: 10, intensity: 1 });
R.recovery.y0 = { burned: await patch(A, 10), control: await patch(B, 10) };
let yr = 0;
for (const [to, bd] of [[1, 5], [2, 5], [5, 10], [10, 30], [20, 365 / 2], [40, 365], [70, 365], [120, 365000 / 60]]) {
  await sim.run((to - yr) * 365, { batchDays: bd, nSub: 32 });
  yr = to;
  R.recovery['y' + to] = { burned: await patch(A, 10), control: await patch(B, 10) };
}
const rb = R.recovery;
R.recoverySummary = {
  vegBefore: rb.before.burned.veg, vegAfterFire: rb.y0.burned.veg, vegAfter5y: rb.y5.burned.veg, vegAfter120y: rb.y120.burned.veg,
  woodyBefore: rb.before.burned.woody, woodyAfterFire: rb.y0.burned.woody, woodyAfter20y: rb.y20.burned.woody, woodyAfter120y: rb.y120.burned.woody,
  burnAfter5y: rb.y5.burned.burn,
};
// Part 3, catchment scale: 3 years at ~1 year/s before and after burning a 700 m forested area.
await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365 * 200, { batchDays: 365000 / 60 });
const P = { x: 150, y: 120 }, r = 35;   // a forested catchment
const groundC = async () => { const b = await E.readLayer('bedrock'), s = await E.readLayer('soil'); return b.map((v, i) => v + s[i]); };
const measureC = (z0, z1) => { let low = 0, dep = 0, n = 0, mx = 0; for (let y = P.y - r; y <= P.y + r; y++) for (let x = P.x - r; x <= P.x + r; x++) { if ((x - P.x) ** 2 + (y - P.y) ** 2 > r * r) continue; const d = z1[y * N + x] - z0[y * N + x]; if (d < 0) { low -= d; mx = Math.max(mx, -d); } else dep += d; n++; } return { meanLowering_mm: 1000 * low / n, meanDeposit_mm: 1000 * dep / n, maxLowering_m: mx }; };
const out = {};
await sim.run(((200 - (E.day % 365)) + 365) % 365, { batchDays: 5, nSub: 32 });
let z0 = await groundC(); let s0 = (await sim.stats()).cumSedimentOut_m3;
await sim.run(3 * 365, { batchDays: 6, nSub: 64 });
let z1 = await groundC();
out.unburned3y = { ...measureC(z0, z1), sedOut_m3: (await sim.stats()).cumSedimentOut_m3 - s0 };
out.fire = await sim.brush('wildfire', { x: P.x, y: P.y, radius: r });
z0 = await groundC(); s0 = (await sim.stats()).cumSedimentOut_m3;
await sim.run(3 * 365, { batchDays: 6, nSub: 64 });
z1 = await groundC();
out.burned3y = { ...measureC(z0, z1), sedOut_m3: (await sim.stats()).cumSedimentOut_m3 - s0 };
R.catchment = out;

const s1 = await sim.stats();
R.balancePct = s1.balanceErrorPct; R.nan = s1.hasNaN; R.gpuErrors = window.__gpuErrors || 0;
return R;
