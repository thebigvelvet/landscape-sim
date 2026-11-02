await sim.load('random', { size: 256, seed: 5, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365 * 200, { batchDays: 365000 / 60 });
const E = sim.engine, N = E.world.N;
const snap = async () => ({ v: await E.readLayer('veg'), w: await E.readLayer('water'), c: await E.readLayer('clim'), e: await E.readLayer('eco'), so: await E.readLayer('soil'), r: await E.readLayer('rip') });
const a = await snap();
await sim.run(365 * 20, { batchDays: 5, nSub: 32 });
const b = await snap();
// classify cells that lost > 0.1 cover
let lost = 0, lostWet = 0, lostWetB = 0, wiA = 0, wiB = 0, lgA = 0, lgB = 0, tgA = 0, tgB = 0, soA = 0, soB = 0, ripA = 0, ripB = 0;
const smp = [];
for (let i = 0; i < N * N; i++) {
  if (a.v[i] - b.v[i] > 0.1) {
    lost++; if (a.w[i] > 0.05) lostWet++; if (b.w[i] > 0.05) lostWetB++;
    const o = 12 * i + 4;
    wiA += a.c[o] / Math.max(1e-12, a.c[o + 1]); wiB += b.c[o] / Math.max(1e-12, b.c[o + 1]);
    lgA += a.c[o + 2] * 365; lgB += b.c[o + 2] * 365; tgA += a.c[o + 3] / Math.max(1e-6, a.c[o + 2]); tgB += b.c[o + 3] / Math.max(1e-6, b.c[o + 2]);
    soA += a.so[i]; soB += b.so[i]; ripA += a.r[i]; ripB += b.r[i];
    if (smp.length < 6 && i % 7 == 0) smp.push({ vA: a.v[i], vB: b.v[i], TA: a.e[4*i], TB: b.e[4*i], wA: a.w[i], wB: b.w[i], hcB: b.c[12*i+8] });
  }
}
const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;
return { meanA: mean(a.v), meanB: mean(b.v), lostFrac: lost / (N * N), lostWet: lostWet / Math.max(1, lost), lostWetB: lostWetB / Math.max(1, lost),
  WiA: wiA / lost, WiB: wiB / lost, LgsA: lgA / lost, LgsB: lgB / lost, TgsA: tgA / lost, TgsB: tgB / lost, soA: soA / lost, soB: soB / lost, ripA: ripA / lost, ripB: ripB / lost, smp };
