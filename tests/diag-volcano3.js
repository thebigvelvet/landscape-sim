const e = sim.engine, V = e.volcanoes;
sim.pause(); await sim.load('random', { size: 256, seed: 4, preset: 'Colorado alpine', volcanoes: false }); sim.pause();
const h0 = await e.readLayer('initHeight');
const ev = sim.brush('volcano', { x: 128, y: 128 }); await ev.ready;
await e.run(200, { batchDays: 2 });
const [lv, b, so] = await Promise.all(['lava', 'bedrock', 'soil'].map((n) => e.readLayer(n)));
const N = e.N, src = V.vents[0].src;
const cx = 128, cy = 128, S = 3, W = 30;
const lavaMap = [], groundMap = [], tMap = [];
for (let y = cy - W * S / 2 * 2; y < cy + W * S; y += S) {
  let r1 = '', r2 = '', r3 = '';
  for (let x = cx - W * S; x < cx + W * S; x += S) {
    const i = Math.max(0, Math.min(N - 1, y)) * N + Math.max(0, Math.min(N - 1, x));
    const h = lv[4 * i];
    r1 += h < 0.05 ? '.' : h < 2 ? '1' : h < 5 ? '2' : h < 10 ? '3' : h < 20 ? '4' : h < 40 ? '5' : '#';
    r2 += String.fromCharCode(97 + Math.max(0, Math.min(25, Math.floor((h0[i] - 150) / 20))));
    const T = lv[4 * i + 1]; r3 += h < 0.05 ? '.' : T < 0.15 ? 'c' : T < 0.5 ? 'w' : 'H';
  }
  lavaMap.push(r1); groundMap.push(r2); tMap.push(r3);
}
return { src, K: V.K, dt: e.lastPlan.lavaDt, ld: e.lastPlan.v0ld, left: V.vents[0].left, lavaMap, groundMap, tMap };
