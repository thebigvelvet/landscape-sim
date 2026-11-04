// Karst valleys (sim/karst.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/karst-valleys.js --out=tests/out-karst-valleys.json
// Twin runs of the same map with the karst-valley processes on and off (the plain dissolution in
// column.js runs in both), so stream erosion and sediment cannot confuse the answer.
// Checks:
//   dissolvesMore     much more rock dissolved with them on
//   karstValleys      the dissolving belts sink into valleys well below the same ground in the twin
//   hollowsGrow       the largest closed hollow does not shrink over time
//   alongStrike       in Valley and Ridge the dissolved ground lines up along the strike of the
//                     limestone belts (the fold axes), as real karst valleys do
//   rightPlaces       wherever rock has dissolved there is soluble rock (limestone, dolomite, gypsum,
//                     chalk, salt) at or under the original surface, in every province tested
//   plateauAndGulf    plateau limestone/gypsum or salt and Gulf chalk dissolve too
//   books             water and solids balance
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const t0 = performance.now();
const booksOk = (s) => !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1e-3 * (s.cumErupted_m3 + s.cumSedimentOut_m3) + 2000;
const books = [];
const N = 256;

// closed hollows: priority-flood fill of the ground (water leaves at the map edge); hollow cells
// are > 1 m below their spill level. Returns component sizes, largest first.
function hollows(G) {
  const filled = new Float32Array(N * N).fill(Infinity), done = new Uint8Array(N * N);
  // binary heap on (height, index)
  const hz = [], hi = [];
  const push = (z, i) => { hz.push(z); hi.push(i); let k = hz.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (hz[p] <= hz[k]) break; [hz[p], hz[k]] = [hz[k], hz[p]]; [hi[p], hi[k]] = [hi[k], hi[p]]; k = p; } };
  const pop = () => {
    const z = hz[0], i = hi[0], lz = hz.pop(), li = hi.pop();
    if (hz.length) { hz[0] = lz; hi[0] = li; let k = 0; for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < hz.length && hz[l] < hz[m]) m = l; if (r < hz.length && hz[r] < hz[m]) m = r; if (m === k) break; [hz[m], hz[k]] = [hz[k], hz[m]]; [hi[m], hi[k]] = [hi[k], hi[m]]; k = m; } }
    return [z, i];
  };
  for (let x = 0; x < N; x++) for (const y of [0, N - 1]) { const i = y * N + x; if (!done[i]) { done[i] = 1; filled[i] = G[i]; push(G[i], i); } }
  for (let y = 1; y < N - 1; y++) for (const x of [0, N - 1]) { const i = y * N + x; if (!done[i]) { done[i] = 1; filled[i] = G[i]; push(G[i], i); } }
  while (hz.length) {
    const [z, i] = pop();
    const x = i % N, y = (i / N) | 0;
    for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + ox, yy = y + oy;
      if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
      const j = yy * N + xx;
      if (done[j]) continue;
      done[j] = 1; filled[j] = Math.max(G[j], z); push(filled[j], j);
    }
  }
  const lab = new Int32Array(N * N).fill(-1), sizes = [];
  for (let i = 0; i < N * N; i++) {
    if (lab[i] >= 0 || filled[i] - G[i] <= 1) continue;
    const id = sizes.length; let n = 0; const st = [i]; lab[i] = id;
    while (st.length) {
      const c = st.pop(); n++;
      const x = c % N, y = (c / N) | 0;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + ox, yy = y + oy;
        if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue;
        const j = yy * N + xx;
        if (lab[j] < 0 && filled[j] - G[j] > 1) { lab[j] = id; st.push(j); }
      }
    }
    sizes.push(n);
  }
  return sizes.sort((a, b) => b - a);
}
const ground = async () => { const [b, s] = await Promise.all(['bedrock', 'soil'].map((n) => e.readLayer(n))); return b.map((v, i) => v + s[i]); };

// soluble rock at or under the original surface of each dissolved cell (beds, salt or sinkholes)
function rightPlaces(b0, b1, K, T) {
  let n = 0, ok = 0;
  for (let y = 1; y < N - 1; y++) for (let x = 1; x < N - 1; x++) {
    const i = y * N + x;
    if (K[4 * i] < 1) continue;
    n++;
    let sol = sim.anomalyAt(x, y, T).some((a) => ['sinkhole', 'salt', 'pipe'].includes(a.type));
    // from the original surface down to 64 m under today's rock surface (the column kernel also
    // dissolves soluble beds up to 60 m down)
    for (let d = 0; d <= b0[i] - b1[i] + 64 && !sol; d += 2) if (T.beds[sim.strataLayer(b0[i] - d, x, y, T)].sol > 0) sol = true;
    if (sol) ok++;
  }
  return { cells: n, onSoluble: ok, frac: n ? ok / n : 1 };
}

async function run(prov, seed, preset, years, on, snapAt) {
  sim.pause(); await sim.load('random', { size: N, seed, preset, province: prov, volcanoes: false }); sim.pause();
  e.karstValleys = on;
  const b0 = await e.readLayer('bedrock');
  const out = { prov, seed, on };
  if (snapAt) { await e.run(snapAt * 365); const h = hollows(await ground()); out.snapLargest = h[0] || 0; out.snapCells = h.reduce((a, v) => a + v, 0); }
  await e.run((years - (snapAt || 0)) * 365);
  const ks = await sim.karstStats();
  const G1 = await ground();
  Object.defineProperty(out, '_G', { value: G1, enumerable: false });
  Object.defineProperty(out, '_K', { value: ks.layer, enumerable: false });
  const h = hollows(G1);
  Object.assign(out, { dissolved_m3: ks.dissolved_m3, deepest_m: ks.deepest_m, area1m_m2: ks.area1m_m2, largest: h[0] || 0, hollows10: h.filter((v) => v >= 10).length, hollowCells: h.reduce((a, v) => a + v, 0) });
  out.places = rightPlaces(b0, await e.readLayer('bedrock'), ks.layer, e.strataInfo);
  // lined up along the strike? how often a cell 3 away along the strike is dissolved too, against 3 away across it
  {
    const S = e.strataInfo.struct, a = Math.atan2(S.foldKy, S.foldKx) + Math.PI / 2, tx = Math.cos(a), ty = Math.sin(a);
    let n = 0, al = 0, ac = 0;
    const K = ks.layer, dis = (x, y) => { const xi = Math.round(x), yi = Math.round(y); return xi >= 0 && yi >= 0 && xi < N && yi < N && K[4 * (yi * N + xi)] > 2; };
    for (let y = 4; y < N - 4; y++) for (let x = 4; x < N - 4; x++) {
      if (!dis(x, y)) continue;
      n++;
      for (const k of [-3, 3]) { if (dis(x + k * tx, y + k * ty)) al++; if (dis(x - k * ty, y + k * tx)) ac++; }
    }
    out.along = n ? al / (2 * n) : 0; out.across = n ? ac / (2 * n) : 0;
  }
  // orientation of the dissolved ground (cells > 2 m) by its principal axis
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let i = 0; i < N * N; i++) if (ks.layer[4 * i] > 2) { const x = i % N, y = (i / N) | 0; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++; }
  if (n > 20) {
    const mx = sx / n, my = sy / n, cxx = sxx / n - mx * mx, cyy = syy / n - my * my, cxy = sxy / n - mx * my;
    out.axis = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const l1 = 0.5 * (cxx + cyy) + Math.sqrt(0.25 * (cxx - cyy) ** 2 + cxy * cxy), l2 = 0.5 * (cxx + cyy) - Math.sqrt(0.25 * (cxx - cyy) ** 2 + cxy * cxy);
    out.elong = Math.sqrt(l1 / Math.max(l2, 1e-6));
  }
  const S = e.strataInfo.struct;
  out.strike = Math.atan2(S.foldKy, S.foldKx) + Math.PI / 2;
  const s = await sim.stats();
  books.push({ run: `${prov} ${seed} ${on ? 'on' : 'off'}`, ok: booksOk(s), bal: s.balanceErrorPct, solids: s.solidsError_m3, sedOut: s.cumSedimentOut_m3 });
  R.runs[`${prov}${seed}${on ? 'on' : 'off'}`] = out;
  return out;
}

const on = await run('valleyRidge', 3, 'Temperate', 20000, true, 5000);
const off = await run('valleyRidge', 3, 'Temperate', 20000, false);
e.karstValleys = true;
check('dissolvesMore', on.dissolved_m3 > 3 * off.dissolved_m3, { on: on.dissolved_m3, off: off.dissolved_m3 });
{
  // the karst belts are cut down into valleys: compare the ground with the twin, where it dissolved
  let n = 0, d = 0;
  for (let i = 0; i < N * N; i++) if (on._K[4 * i] > 2) { n++; d += off._G[i] - on._G[i]; }
  check('karstValleys', n > 200 && d / n > 5, { cells: n, deeperThanTwin_m: n ? d / n : 0, hollowCellsOn: on.hollowCells, hollowCellsOff: off.hollowCells });
}
check('hollowsGrow', on.largest >= on.snapLargest, { at5kyr: on.snapLargest, at20kyr: on.largest });
check('alongStrike', on.along > 1.5 * on.across, { along: on.along, across: on.across });
const gulf = await run('gulf', 3, 'Gulf Coast humid', 10000, true);
// a plateau map with soluble rock near the surface (limestone, gypsum, or the salt anticline)
let pl = null;
for (const seed of [5, 1, 2, 3]) {
  pl = await run('plateau', seed, 'Utah desert', 10000, true);
  if (pl.area1m_m2 > 0) break;
}
check('plateauAndGulf', gulf.area1m_m2 > 0 && pl.area1m_m2 > 0, { gulf: gulf.area1m_m2, gulfDeepest: gulf.deepest_m, plateau: pl.area1m_m2, plateauSeed: pl.seed, plateauDeepest: pl.deepest_m });
check('rightPlaces', [on, gulf, pl].every((r) => r.places.frac >= 0.95), { vr: on.places, gulf: gulf.places, plateau: pl.places });
check('books', books.every((q) => q.ok), { books });
R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
check('noGpuErrors', R.gpuErrors === 0, { errors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
return R;
