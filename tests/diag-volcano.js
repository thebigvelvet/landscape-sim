// Quick volcano smoke check:
//   node scripts/launch.cjs --eval=tests/diag-volcano.js --out=tests/out-diag-volcano.json
const e = sim.engine;
const R = { errors0: window.__gpuErrors || 0 };
sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine', volcanoes: false }); sim.pause();
R.limits = { storage: e.device.limits.maxStorageBuffersPerShaderStage, frag: e.device.limits.maxStorageBuffersInFragmentStage };
const ev = sim.brush('volcano', { x: 128, y: 128 });
await ev.ready;
R.event = { r: ev.r, coneHeight: ev.coneHeight, cinders: ev.cinders, lava: ev.lava };
R.after0 = await sim.volcanoStats();
const t0 = performance.now();
const marks = [];
for (const d of [30, 120, 365, 730, 1500]) {
  await e.run(d - e.day, { batchDays: 2 });
  const v = await sim.volcanoStats(), s = await sim.stats();
  marks.push({ day: e.day, cone: v.vents[0]?.coneHeight_m, basalt: v.basalt_m3, cinders: v.cinders_m3, plug: v.plug_m3, molten: v.moltenLava_m3, hot: v.hotLavaCells, erupted: v.erupted_m3, solidsErr: s.solidsError_m3, sedOut: s.cumSedimentOut_m3, balPct: s.balanceErrorPct, nan: s.hasNaN });
}
R.marks = marks;
R.ms = performance.now() - t0;
R.errors = window.__gpuErrors || 0;
R.errorMsgs = window.__gpuErrorMsgs || [];
return R;
