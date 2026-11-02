// Shared analysis for the round-2 ecology tests. Not a test by itself: other tests prepend it.
// (The eval harness runs one file as an async function body, so tests/run-eco.cjs concatenates.)
async function ecoSurvey(sim) {
  const E = sim.engine;
  const N = E.world.N, dx = E.cellSize;
  const [br, so, veg, eco, wat, gw, spr, clim] = await Promise.all(
    ['bedrock', 'soil', 'veg', 'eco', 'water', 'groundwater', 'spring', 'clim'].map((n) => E.readLayer(n)));
  const z = new Float32Array(N * N);
  for (let i = 0; i < N * N; i++) z[i] = br[i] + so[i] + E.datum;
  let zmin = Infinity, zmax = -Infinity;
  for (const v of z) { zmin = Math.min(zmin, v); zmax = Math.max(zmax, v); }
  const NB = 10;
  const bands = Array.from({ length: NB }, (_, k) => ({ z0: zmin + (k * (zmax - zmin)) / NB, n: 0, v: 0, t: 0, nN: 0, vN: 0, nS: 0, vS: 0, tN: 0, tS: 0, wi: 0, tgs: 0, soil: 0, rN: 0, rV: 0, uN: 0, uV: 0 }));
  // channel mask and distance (in cells, up to 12) by repeated dilation
  const chan = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) chan[i] = wat[i] >= 0.05 || spr[i] > 2e-4 ? 1 : 0;
  const dist = new Uint8Array(N * N).fill(255);
  for (let i = 0; i < N * N; i++) if (chan[i]) dist[i] = 0;
  for (let k = 1; k <= 12; k++) {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const i = y * N + x;
      if (dist[i] !== 255) continue;
      if ((x > 0 && dist[i - 1] === k - 1) || (x < N - 1 && dist[i + 1] === k - 1) || (y > 0 && dist[i - N] === k - 1) || (y < N - 1 && dist[i + N] === k - 1)) dist[i] = k;
    }
  }
  let rip = { n: 0, v: 0 }, upl = { n: 0, v: 0 };
  let nChan = 0; for (let i = 0; i < N * N; i++) nChan += chan[i];
  let soilForest = { n: 0, s: 0 }, soilBare = { n: 0, s: 0 };
  let tot = { v: 0, t: 0, b: 0 };
  const margin = 4;
  for (let y = margin; y < N - margin; y++) for (let x = margin; x < N - margin; x++) {
    const i = y * N + x;
    const V = veg[i], T = eco[4 * i];
    tot.v += V; tot.t += T; tot.b += eco[4 * i + 1] > 0.1 ? 1 : 0;
    const k = Math.min(NB - 1, Math.floor(((z[i] - zmin) / (zmax - zmin + 1e-9)) * NB));
    const b = bands[k];
    b.n++; b.v += V; b.t += T; b.soil += so[i];
    const o = 12 * i + 4;   // last complete year
    const c = clim[o + 2];
    b.wi += clim[o + 1] > 0 ? clim[o] / clim[o + 1] : 0;
    b.tgs += c > 1e-4 ? clim[o + 3] / c : -20;
    const gy = (z[i + N] - z[i - N]) / (2 * dx);
    const gx = (z[i + 1] - z[i - 1]) / (2 * dx);
    // north-facing: ground rises toward +y (south), i.e. the slope faces north
    if (gy > 0.25 && Math.abs(gx) < gy) { b.nN++; b.vN += V; b.tN += T; }
    if (gy < -0.25 && Math.abs(gx) < -gy) { b.nS++; b.vS += V; b.tS += T; }
    if (!chan[i] && dist[i] >= 1 && dist[i] <= 2) { rip.n++; rip.v += V; b.rN++; b.rV += V; }
    if (dist[i] > 10) { upl.n++; upl.v += V; b.uN++; b.uV += V; }
    if (T > 0.5) { soilForest.n++; soilForest.s += so[i]; }
    if (V < 0.1 && T < 0.05) { soilBare.n++; soilBare.s += so[i]; }
  }
  const inner = (N - 2 * margin) ** 2;
  // riparian minus upland cover at the same elevation (weighted by riparian cells)
  let rx = 0, rw = 0;
  for (const b of bands) if (b.rN > 20 && b.uN > 20) { rx += (b.rV / b.rN - b.uV / b.uN) * b.rN; rw += b.rN; }
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const bandsOut = bands.map((b) => ({
    z: Math.round(b.z0), cells: b.n, veg: r3(b.v / Math.max(1, b.n)), woody: r3(b.t / Math.max(1, b.n)),
    Wi: r3(b.wi / Math.max(1, b.n)), Tgs: r3(b.tgs / Math.max(1, b.n)), soil: r3(b.soil / Math.max(1, b.n)),
    vegNorth: b.nN > 30 ? r3(b.vN / b.nN) : null, vegSouth: b.nS > 30 ? r3(b.vS / b.nS) : null,
    woodyNorth: b.nN > 30 ? r3(b.tN / b.nN) : null, woodySouth: b.nS > 30 ? r3(b.tS / b.nS) : null,
  }));
  // treeline: lowest band above which every band has woody cover < 0.1 (null if trees reach the top)
  let treeline = null;
  for (let k = NB - 1; k >= 0; k--) { if (bandsOut[k].woody >= 0.1) { treeline = k < NB - 1 ? bandsOut[k + 1].z : null; break; } }
  // aspect contrast pooled over bands that have both faces
  let nN = 0, vN = 0, nS = 0, vS = 0, tN = 0, tS = 0;
  for (const b of bands) if (b.nN > 30 && b.nS > 30) { nN += b.nN; vN += b.vN; nS += b.nS; vS += b.vS; tN += b.tN; tS += b.tS; }
  return {
    N, zmin: Math.round(zmin), zmax: Math.round(zmax), channelFrac: r3(nChan / (N * N)),
    meanVeg: r3(tot.v / inner), meanWoody: r3(tot.t / inner), burnedFrac: r3(tot.b / inner),
    treelineElevation: treeline,
    northFaceVeg: nN ? r3(vN / nN) : null, southFaceVeg: nS ? r3(vS / nS) : null,
    northFaceWoody: nN ? r3(tN / nN) : null, southFaceWoody: nS ? r3(tS / nS) : null,
    riparianVeg: rip.n ? r3(rip.v / rip.n) : null, uplandVeg: upl.n ? r3(upl.v / upl.n) : null, riparianCells: rip.n, riparianExcessSameElevation: rw ? r3(rx / rw) : null, uplandCells: upl.n,
    soilUnderForest: soilForest.n > 50 ? r3(soilForest.s / soilForest.n) : null, soilBare: soilBare.n > 50 ? r3(soilBare.s / soilBare.n) : null,
    bands: bandsOut,
  };
}
// mean of a layer inside a circle (grid cells); comp picks a component for vec4 layers
async function circleMean(sim, name, cx, cy, r, comp = -1) {
  const E = sim.engine, N = E.world.N;
  const a = await E.readLayer(name);
  let s = 0, n = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(N - 1, Math.ceil(cy + r)); y++)
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(N - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const i = y * N + x;
      s += comp < 0 ? a[i] : a[4 * i + comp]; n++;
    }
  return s / Math.max(1, n);
}
const pickStats = (s) => ({ year: Math.round(s.year * 10) / 10, balPct: s.balanceErrorPct, nan: s.hasNaN, meanVeg: s.meanVeg, vegCoveredFrac: s.vegCoveredFrac, burnedFrac: s.burnedFrac });
