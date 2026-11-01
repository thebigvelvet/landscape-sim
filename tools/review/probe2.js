(async () => {
  const S = window.sim, E = S.engine; const out = {};
  for (const day of [365 + 135, 365 + 165, 365 + 185]) {
    await S.load('cone', { size: 256, seed: 1, preset: 'Colorado alpine' });
    await S.run(day);
    const N = E.world.N;
    const swe = await E.readLayer('snowSWE'), br = await E.readLayer('bedrock'), so = await E.readLayer('soil');
    const h = (i) => br[i] + so[i];
    let n = [0, 0, 0], s = [0, 0, 0];
    for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
      const i = y * N + x; const gy = (h(i + N) - h(i - N)) / 20; const gx = (h(i + 1) - h(i - 1)) / 20;
      if (Math.abs(gy) < 0.15 || Math.abs(gx) > Math.abs(gy)) continue;
      const t = gy > 0 ? n : s;   // ground rising to the south = faces north
      t[0] += swe[i]; t[1]++; if (swe[i] > 0.005) t[2]++;
    }
    out['day' + day] = { northMeanSWE_mm: 1000 * n[0] / n[1], southMeanSWE_mm: 1000 * s[0] / s[1], northSnowCover: n[2] / n[1], southSnowCover: s[2] / s[1] };
  }
  return out;
})()
