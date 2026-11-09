// Round 13 pictures. Harness: sh tests/shoot-data.sh <name> 'window.__mode="scarp"' tests/visual-quakes.js
//   scarp   a Southern Rockies map (window.__seed, default 1) after window.__years (default 4000) of
//           natural quakes, looking along fault window.__fault (default 0) at its scarp
//   glow    the same map, a moment after a forced M6.8 on that fault: the trace glows
//   fade    one forced M7.0 on fault window.__fault with natural quakes off, then window.__age years
//           (default 0) later: the fresh rock on the broken face weathering back
//   slides  a forced M6.8 under the middle of the map, then the Change overlay (window.__overlay,
//           default 'change'): landslide scars and the rubble below them
const e = sim.engine, c = sim.renderer.camera, Q = e.quakes, mode = window.__mode || 'scarp';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = { mode };
const N = window.__size || 256, cc = (N - 1) / 2;
const seed = window.__seed ?? (mode === 'slides' ? 3 : 1);
await sim.load('random', { size: N, seed, preset: 'Colorado alpine', province: 'rockies', volcanoes: false }); sim.pause();
const k = window.__fault ?? 0, f = e.strataInfo.struct.faults[k], cs = e.world.cellSize;
let fx = cc, fy = cc;
if (mode === 'slides') {
  await e.run(200);   // summer of the first year: the Change view then shows little but the quake
  Q.enabled = false;
  if (window.__noQuake) { /* the same view without the quake */ }
  else if (window.__faultQuake) Q.force({ fault: k, M: window.__M ?? 7.2 });
  else Q.force({ fault: -1, M: window.__M ?? 6.8, x: cc, y: cc });
  await e.run(2);
} else if (mode === 'fade') {
  Q.enabled = false;
  await e.run(200);
  Q.force({ fault: k, M: 7.0 });
  await e.run(1);
  if (window.__age) await e.run(365 * window.__age);
  const doy = ((e.day % 365) + 365) % 365;
  await e.run((220 - doy + 365) % 365 || 365, { batchDays: 5 });
  Q.glow = null;
  fx = f.nx * f.c / cs + cc; fy = f.ny * f.c / cs + cc;
  c.yaw = window.__yaw ?? Math.atan2(-f.ny, f.nx) + Math.PI / 2 + 0.35;
} else {
  await e.run(365 * (window.__years ?? (mode === 'glow' ? 300 : 4000)));
  const doy = ((e.day % 365) + 365) % 365;
  await e.run((220 - doy + 365) % 365 || 365, { batchDays: 5 });
  if (mode === 'glow') { Q.enabled = false; Q.force({ fault: k, M: 6.8 }); await e.run(1); }
  // a point on the trace near the middle of the map; look along the trace from the up side
  fx = f.nx * f.c / cs + cc; fy = f.ny * f.c / cs + cc;
  c.yaw = window.__yaw ?? Math.atan2(-f.ny, f.nx) + Math.PI / 2 + 0.35;
}
// window.__clearFresh: wipe the fresh-rock marks (karst.w) for a same-view comparison without them
if (window.__clearFresh) { const kk = await e.readLayer('karst'); for (let i = 3; i < kk.length; i += 4) kk[i] = 0; e.device.queue.writeBuffer(e.world.buffers.karst, 0, kk); }
out.log = Q.log.map((q) => `${Math.round(q.day / 365)}y M${q.M.toFixed(1)} ${q.kind}`).slice(-15);
out.count = Q.count; out.slip = Q.slipTotal;
c.pitch = window.__pitch ?? (mode === 'slides' ? 0.75 : mode === 'fade' ? 0.95 : 0.35);
if (window.__fx !== undefined) { fx = window.__fx; fy = window.__fy; }
const [wx, wz] = sim.renderer.gridToWorld(fx, fy);
c.target[0] = wx; c.target[2] = wz;
c.dist *= window.__zoom ?? (mode === 'slides' ? 0.7 : mode === 'fade' ? 0.6 : 0.35);
if (mode === 'slides') sim.setOverlay(window.__overlay ?? 'change');
else if (window.__overlay) sim.setOverlay(window.__overlay);
e.lastClimate && (e.lastClimate.precipRate_mm_per_day = 0);
sim.renderer.cloud = 0;
if (mode === 'glow' && !window.__noGlow) { Q.glow.t0 = performance.now(); await sleep(600); c.shakeAmp = 0; }
else if (mode === 'glow') { Q.glow = null; await sleep(2500); c.shakeAmp = 0; }   // window.__noGlow: the fresh break alone
else { Q.glow = null; await sleep(2500); }   // no leftover glow from the last natural quake
const s = await sim.stats();
Object.assign(out, { day: e.day, bal: s.balanceErrorPct, solidsErr: s.solidsError_m3, nan: s.hasNaN, gpuErrors: window.__gpuErrors || 0, gpuMsgs: window.__gpuErrorMsgs });
out.png = sim.renderer.canvas.toDataURL('image/png');
// window.__diff: how much of the picture the fresh rock changes (pixels whose colour moves by > 30 of 765)
if (window.__diff) {
  const px = async (url) => { const img = new Image(); img.src = url; await img.decode(); const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height; const g = cv.getContext('2d'); g.drawImage(img, 0, 0); return g.getImageData(0, 0, img.width, img.height).data; };
  const A = await px(out.png);
  const kk = await e.readLayer('karst'); for (let i = 3; i < kk.length; i += 4) kk[i] = 0; e.device.queue.writeBuffer(e.world.buffers.karst, 0, kk);
  await sleep(1500);
  const B = await px(sim.renderer.canvas.toDataURL('image/png'));
  let big = 0; for (let i = 0; i < A.length; i += 4) if (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2]) > 30) big++;
  out.freshPixelsPct = +(100 * big / (A.length / 4)).toFixed(2);
}
return out;
