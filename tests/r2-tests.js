// Round-2 checks, part 1: water balance and NaN with plants and every brush at both ends of the
// speed dial, storm water scaling with speed, and brushes landing where clicked.
// Run: node tests/run-eco.cjs tests/r2-tests.js
const R = { pass: {} };
const FAST = 365000 / 60;            // one frame at 1000 yr/s
const SLOW = 1 / 60;                 // one frame at 1 day/s
const E = sim.engine;

// ---------- 1. balance + NaN, every brush, slow and fast ----------
R.balance = {};
for (const brush of ['none', 'storm', 'drought', 'flood', 'wildfire']) {
  for (const [speed, bd, days] of [['1 day/s', SLOW, 4], ['1000 yr/s', FAST, 365 * 300]]) {
    await sim.load('random', { size: 256, seed: 2, preset: 'Colorado alpine' }); sim.pause();
    await sim.run(365 * 50, { batchDays: FAST });          // plants and soil settle first
    await sim.run(((200 - (E.day % 365)) + 365) % 365, { batchDays: 5 });   // midsummer
    let info = null;
    const N = E.world.N;
    if (brush !== 'none') info = await sim.brush(brush, { x: N * 0.5, y: N * 0.45, radius: 30 });
    await sim.run(days, { batchDays: bd, nSub: 16 });
    const s = await sim.stats();
    R.balance[`${brush} @ ${speed}`] = { balPct: s.balanceErrorPct, nan: s.hasNaN, meanVeg: +s.meanVeg.toFixed(3), burnedFrac: s.burnedFrac, burnedCells: info?.burnedCells };
  }
}
R.maxAbsBalancePct = Math.max(...Object.values(R.balance).map((b) => Math.abs(b.balPct)));
R.pass.balance = R.maxAbsBalancePct < 0.01;
R.pass.noNaN = Object.values(R.balance).every((b) => !b.nan);

// ---------- 2. a 3-day storm delivers ~3 days of storm water at any speed ----------
// Compare cumulative precipitation with and without the storm, same seed and batches.
R.stormScaling = {};
for (const [speed, bd, days] of [['1 day/s', SLOW, 4], ['1 yr/s', 6, 30], ['1000 yr/s', FAST, FAST]]) {
  const runOnce = async (withStorm) => {
    await sim.load('cone', { size: 256, seed: 1, preset: 'Temperate' }); sim.pause();
    let expected = 0;
    if (withStorm) {
      await sim.brush('storm', { x: 128, y: 128, radius: 40, days: 3 });
      const evt = await E.readLayer('evt');
      for (let i = 0; i < evt.length; i += 4) expected += evt[i];
      expected *= E.cellSize ** 2;
    }
    await sim.run(days, { batchDays: bd, nSub: 16 });
    const s = await sim.stats();
    return { precip: s.cumPrecip_m3, expected, bal: s.balanceErrorPct };
  };
  const a = await runOnce(false), b = await runOnce(true);
  R.stormScaling[speed] = { stormWaterPainted_m3: Math.round(b.expected), extraPrecipDelivered_m3: Math.round(b.precip - a.precip), ratio: +((b.precip - a.precip) / b.expected).toFixed(4), balPct: b.bal };
}
R.pass.stormScaling = Object.values(R.stormScaling).every((s) => Math.abs(s.ratio - 1) < 0.02);

// ---------- 3. brushes land where clicked ----------
await sim.load('random', { size: 256, seed: 2, preset: 'Temperate' }); sim.pause();
await sim.run(365 * 50, { batchDays: FAST });
await sim.run(((200 - (E.day % 365)) + 365) % 365, { batchDays: 5 });
const N = E.world.N;
const centroid = (arr, stride, comp, thresh = 1e-6) => {
  let sx = 0, sy = 0, sw = 0;
  for (let i = 0; i < N * N; i++) { const w = arr[i * stride + comp]; if (w > thresh) { sx += (i % N) * w; sy += Math.floor(i / N) * w; sw += w; } }
  return sw > 0 ? { x: +(sx / sw).toFixed(2), y: +(sy / sw).toFixed(2) } : null;
};
R.placement = {};
// (a) the API: storm footprint centred on (x, y)
await sim.brush('storm', { x: 70, y: 180, radius: 12 });
R.placement.apiStorm = { asked: { x: 70, y: 180 }, got: centroid(await E.readLayer('evt'), 4, 0) };
// (b) a real click: project a grid cell to the screen, pick it back, then click there with the tool
sim.play(); sim.setSpeed(1);
sim.setTool('drought');
await new Promise((r) => setTimeout(r, 2500));          // height cache + a few frames
sim.pause();
const H = await E.readLayer('bedrock'), S = await E.readLayer('soil'), W = await E.readLayer('snowSWE');
const r = sim.renderer, c = (N - 1) / 2;
const canvas = document.getElementById('view');
const rect = canvas.getBoundingClientRect();
// grid cell -> screen point, using the matrices of the last rendered frame
const toScreen = (gx, gy) => {
  const h = (i) => H[i] + S[i] + W[i] / 0.33;
  const x0 = Math.min(N - 2, Math.floor(gx)), y0 = Math.min(N - 2, Math.floor(gy)), tx = gx - x0, ty = gy - y0, i0 = y0 * N + x0;
  const hb = (h(i0) * (1 - tx) + h(i0 + 1) * tx) * (1 - ty) + (h(i0 + N) * (1 - tx) + h(i0 + N + 1) * tx) * ty;
  const wp = [(gx - c) * E.cellSize, hb * r.vex, (gy - c) * E.cellSize, 1];
  const m = r.lastMatrices.viewProj;
  const clip = [0, 1, 2, 3].map((k) => m[k] * wp[0] + m[4 + k] * wp[1] + m[8 + k] * wp[2] + m[12 + k] * wp[3]);
  return { x: rect.left + (clip[0] / clip[3] * 0.5 + 0.5) * rect.width, y: rect.top + (0.5 - clip[1] / clip[3] * 0.5) * rect.height };
};
// round trip on a grid of screen points: screen -> picked cell -> screen must come back to the same pixel
let worst = 0, hits = 0;
for (let fy = 0.3; fy <= 0.8; fy += 0.1) for (let fx = 0.35; fx <= 0.85; fx += 0.1) {
  const px = rect.left + fx * rect.width, py = rect.top + fy * rect.height;
  const p = sim.pick(px, py);
  if (!p || p.x < 1 || p.y < 1 || p.x > N - 2 || p.y > N - 2) continue;   // misses and the block's sides
  hits++;
  const back = toScreen(p.x, p.y);
  worst = Math.max(worst, Math.hypot(back.x - px, back.y - py));
}
R.placement.pickRoundTrip = { screenPointsHit: hits, worstErrorPx: +worst.toFixed(2) };
// click in the middle of the view with the drought tool
const sx = rect.left + 0.6 * rect.width, sy = rect.top + 0.55 * rect.height;
const target = sim.pick(sx, sy);
R.placement.screen = { x: Math.round(sx), y: Math.round(sy) };
const evtBefore = await E.readLayer('evt');
canvas.dispatchEvent(new PointerEvent('pointerdown', { clientX: sx, clientY: sy, button: 0, buttons: 1, bubbles: true, pointerId: 1 }));
canvas.dispatchEvent(new PointerEvent('pointerup', { clientX: sx, clientY: sy, button: 0, buttons: 0, bubbles: true, pointerId: 1 }));
await new Promise((res) => setTimeout(res, 800));
const evtAfter = await E.readLayer('evt');
const dd = new Float32Array(N * N);
for (let i = 0; i < N * N; i++) dd[i] = Math.max(0, evtAfter[4 * i + 2] - evtBefore[4 * i + 2]);
R.placement.clickDrought = { asked: target, got: centroid(dd, 1, 0) };
sim.setTool('off');
const err = (a, b) => (b ? Math.hypot(a.x - b.x, a.y - b.y) : 1e9);
R.placement.errCells = { apiStorm: +err(R.placement.apiStorm.asked, R.placement.apiStorm.got).toFixed(2), click: +err(target, R.placement.clickDrought.got).toFixed(2) };
R.pass.placement = Object.values(R.placement.errCells).every((e) => e < 2) && R.placement.pickRoundTrip.worstErrorPx < 3 && R.placement.pickRoundTrip.screenPointsHit > 10;
// (c) wildfire: burned area is around the click and stops at bare/wet ground
const fire = await sim.brush('wildfire', { x: 120, y: 200, radius: 10 });
R.placement.fire = { ...fire, centroid: centroid(await E.readLayer('eco'), 4, 1, 0.05) };

R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs;
R.pass.noGpuErrors = R.gpuErrors === 0;
R.allPass = Object.values(R.pass).every(Boolean);
return R;
