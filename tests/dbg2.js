await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365 * 200, { batchDays: 365000 / 60 });
const E = sim.engine, N = E.world.N;
const snap = async () => ({ v: await E.readLayer('veg'), e: await E.readLayer('eco'), b: await E.readLayer('bedrock'), so: await E.readLayer('soil'), w: await E.readLayer('water'), c: await E.readLayer('clim'), sn: await E.readLayer('snowSWE') });
const a = await snap();
const out = {};
let maxW = new Float32Array(N * N);
for (let k = 0; k < 20; k++) { await sim.run(365 / 4, { batchDays: 5, nSub: 32 }); const w = await E.readLayer('water'); for (let i = 0; i < N * N; i++) maxW[i] = Math.max(maxW[i], w[i]); }
const b = await snap();
let lost = 0, buried = 0, stripped = 0, wet = 0, gTlost = 0, gGlost = 0, wiA = 0, wiB = 0, lgA = 0, lgB = 0;
for (let i = 0; i < N * N; i++) {
  const dv = a.v[i] - b.v[i];
  if (dv > 0.2) {
    lost++;
    const dz = b.b[i] + b.so[i] - a.b[i] - a.so[i];
    if (dz > 0.05) buried++; if (dz < -0.05) stripped++; if (maxW[i] > 0.08) wet++;
    gTlost += a.e[4*i] - b.e[4*i]; gGlost += (a.v[i] - a.e[4*i]) - (b.v[i] - b.e[4*i]);
    const o = 12 * i + 4; wiA += a.c[o] / Math.max(1e-12, a.c[o+1]); wiB += b.c[o] / Math.max(1e-12, b.c[o+1]); lgA += a.c[o+2]*365; lgB += b.c[o+2]*365;
  }
}
return { lostFrac: lost / (N*N), buried: buried / lost, stripped: stripped / lost, wetEver: wet / lost, woodyLost: gTlost / lost, grassLost: gGlost / lost, WiA: wiA / lost, WiB: wiB / lost, LgsA: lgA / lost, LgsB: lgB / lost, dayEnd: E.day % 365 };
