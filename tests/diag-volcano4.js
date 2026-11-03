// cinder cone wear vs a basalt twin, with the cinder erodibility from window.__erode
const e = sim.engine;
const typeAt = (vr, i, z) => sim.volcLayer(vr, i % e.N, Math.floor(i / e.N), z);
async function twin(edit) {
  sim.pause(); await sim.load('valley', { size: 256, seed: 3, relief: 0.6, preset: 'Colorado alpine', volcanoes: false }); sim.pause();
  const ev = sim.brush('volcano', { x: 153, y: 184 }); await ev.ready;
  while (true) { await e.run(30, { batchDays: 2 }); const s = await sim.stats(); if (!s.erupting && s.hotLavaCells === 0) break; }
  const vr = await e.readLayer('volcRock'), b = await e.readLayer('bedrock');
  const types = new Int8Array(e.N * e.N);
  for (let i = 0; i < e.N * e.N; i++) types[i] = typeAt(vr, i, b[i] - 0.01);
  if (edit) { edit(vr); e.device.queue.writeBuffer(e.world.buffers.volcRock, 0, vr); }
  const so0 = await e.readLayer('soil');
  let peak0 = 0; for (let i = 0; i < e.N * e.N; i++) if (types[i] === 2) peak0 = Math.max(peak0, b[i] + so0[i]);
  await e.run(20000 * 365);
  const [b1, so1] = await Promise.all(['bedrock', 'soil'].map((n) => e.readLayer(n)));
  let low = 0, n = 0, soil = 0, peak1 = 0;
  for (let i = 0; i < e.N * e.N; i++) if (types[i] === 2) { low += b[i] + so0[i] - b1[i] - so1[i]; soil += so1[i]; n++; peak1 = Math.max(peak1, b1[i] + so1[i]); }
  return { lowered: low / n, soil: soil / n, peakDrop: peak0 - peak1 };
}
const real = await twin(null);
const bas = await twin((vr) => { for (let i = 0; i < vr.length; i += 8) for (let k = 4; k < 8; k++) if (vr[i + k] === 2) vr[i + k] = 1; });
return { real, bas, ratio: real.lowered / bas.lowered };
