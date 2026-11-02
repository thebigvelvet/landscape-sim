(async () => {
  const S = window.sim, E = S.engine;
  const out = {};
  // 1) valley, Colorado alpine: snow on the two valley sides in mid-June of year 2
  await S.load('valley', { size: 256, seed: 1, preset: 'Colorado alpine' });
  await S.run(365 + 165);
  const N = E.world.N;
  const swe = await E.readLayer('snowSWE'), br = await E.readLayer('bedrock'), so = await E.readLayer('soil');
  let north = [0, 0], south = [0, 0];
  for (let y = 2; y < N - 2; y++) for (let x = 2; x < N - 2; x++) {
    const i = y * N + x;
    const gy = (br[i + N] + so[i + N] - br[i - N] - so[i - N]);
    if (gy > 0.5) { north[0] += swe[i]; north[1]++; } else if (gy < -0.5) { south[0] += swe[i]; south[1]++; }
  }
  out.valleyJune = { meanSWE_northFacing: north[0] / Math.max(1, north[1]), meanSWE_southFacing: south[0] / Math.max(1, south[1]), nN: north[1], nS: south[1], day: E.day };
  // 2) temperate random: groundwater fill distribution and springs after 200 years
  await S.load('random', { size: 512, seed: 7, preset: 'Temperate' });
  await S.run(73000);
  const gw = await E.readLayer('groundwater'), sp = await E.readLayer('spring');
  const gm = E.climate.preset.gwMax;
  const f = Array.from(gw, (v) => v / gm).sort((a, b) => a - b);
  const q = (p) => f[Math.floor(p * (f.length - 1))];
  let springs = 0, spSum = 0; for (const v of sp) { if (v > 1e-4) springs++; spSum += v; }
  out.gw = { p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), springCells: springs, springFrac: springs / sp.length, meanSpring: spSum / sp.length };
  return out;
})()
