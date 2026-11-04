// Natural arches and bridges (sim/arches.js). Run on the real GPU:
//   node scripts/launch.cjs --eval=tests/arches.js --out=tests/out-arches.json
// Checks:
//   finArches         Colorado Plateau maps with joint sets grow fin arches within 15 thousand years
//   rightRock         every arch is in eolian / fluvial sandstone (or arkose), on a map with joints
//   seeThrough        a standing arch has an opening at least 3 m high under a lintel at least 1 m thick
//   lifeCycle         some arches collapse, and more form than fall
//   noneElsewhere     no arches in Valley and Ridge or on the Gulf Coastal Plain (no arch-forming sandstone)
//   noneWithoutJoints a plateau map without joint sets grows no fin arches
//   bridge            a stream in a sandstone canyon looping round a thin meander neck breaks through
//                     it, leaving a natural bridge, and the water then runs through the cut
//   books             water and solids balance in every run (the lintels' rock is held by the arches)
const e = sim.engine;
const R = { checks: {}, runs: {} };
const check = (name, pass, data) => { R.checks[name] = { pass: !!pass, ...data }; };
const t0 = performance.now();
const booksOk = (s) => !s.hasNaN && Math.abs(s.balanceErrorPct) < 0.01 && Math.abs(s.solidsError_m3) < 1e-3 * (s.cumErupted_m3 + s.cumSedimentOut_m3) + 2000;
const books = [];
const N = 256;
const load = async (prov, seed, preset) => {
  sim.pause(); await sim.load('random', { size: N, seed, preset, province: prov, volcanoes: false }); sim.pause();
};

// ---- fin arches on plateau maps with joints ----
const all = [];
let fallen = 0, rightRock = true, seeThrough = null;
for (const seed of [1, 4, 7, 8]) {
  await load('plateau', seed, 'Utah desert');
  const joints = e.strataInfo.struct.joints.length;
  let maxStanding = 0;
  for (let t = 0; t < 15000; t += 2500) {
    await e.run(2500 * 365);
    const a = sim.archStats();
    maxStanding = Math.max(maxStanding, a.standing);
    for (const q of a.list) if (!seeThrough && q.openH >= 3 && q.top - q.floor - q.openH >= 1) seeThrough = q;
    for (const q of a.list) if (!['Eolian sandstone', 'Fluvial sandstone', 'Arkose'].includes(q.rock) || !joints) rightRock = false;
  }
  const a = sim.archStats(), s = await sim.stats();
  books.push({ run: `plateau ${seed}`, ok: booksOk(s), bal: s.balanceErrorPct, solids: s.solidsError_m3, sedOut: s.cumSedimentOut_m3, archRock: s.archRock_m3 });
  fallen += a.fallen;
  R.runs[`plateau${seed}`] = { joints, formed: a.formed, fallen: a.fallen, standing: a.standing, maxStanding, bridges: a.bridgesFormed };
  all.push(R.runs[`plateau${seed}`]);
}
const formed = all.reduce((s, r) => s + r.formed, 0);
check('finArches', all.filter((r) => r.formed >= 1).length >= 3, { runs: all.map((r) => r.formed) });
check('rightRock', rightRock, {});
check('seeThrough', !!seeThrough, { arch: seeThrough });
check('lifeCycle', fallen >= 1 && formed > fallen, { fallen, formed });

// ---- none where there is no arch-forming sandstone, or no joints ----
const none = {};
for (const [prov, seed, preset] of [['valleyRidge', 3, 'Temperate'], ['gulf', 3, 'Gulf Coast humid']]) {
  await load(prov, seed, preset);
  await e.run(10000 * 365);
  const a = sim.archStats(), s = await sim.stats();
  none[prov] = a.formed;
  books.push({ run: `${prov} ${seed}`, ok: booksOk(s), bal: s.balanceErrorPct, solids: s.solidsError_m3 });
}
check('noneElsewhere', none.valleyRidge === 0 && none.gulf === 0, none);
{
  let seed = 2;
  for (; seed < 30; seed++) { await sim.load('random', { size: N, seed, province: 'plateau', volcanoes: false, spinUp: false }); if (!e.strataInfo.struct.joints.length) break; }
  await load('plateau', seed, 'Utah desert');
  await e.run(10000 * 365);
  const a = sim.archStats();
  check('noneWithoutJoints', a.formed - a.bridgesFormed === 0, { seed, formed: a.formed, bridges: a.bridgesFormed });
}

// ---- a natural bridge through a carved meander neck ----
{
  await load('plateau', 4, 'Utah desert');
  await e.run(200 * 365);
  const T = e.strataInfo;
  const [b, s] = await Promise.all(['bedrock', 'soil'].map((n) => e.readLayer(n)));
  // a spot with at least 30 m of eolian or fluvial sandstone under a fairly level surface
  let best = null;
  for (let y = 40; y < N - 40; y += 3) for (let x = 40; x < N - 50; x += 3) {
    const i = y * N + x, z = b[i];
    const k0 = sim.strataLayer(z - 1, x, y, T), k1 = sim.strataLayer(z - 30, x, y, T);
    if (k0 !== k1 || !['eolian', 'massiveSand'].includes(T.beds[k0].type)) continue;
    let lo = Infinity, hi = -Infinity;
    for (let oy = -8; oy <= 8; oy += 2) for (let ox = -24; ox <= 16; ox += 2) { const g = b[(y + oy) * N + x + ox] + s[(y + oy) * N + x + ox]; lo = Math.min(lo, g); hi = Math.max(hi, g); }
    if (!best || hi - lo < best.relief) best = { x, y, relief: hi - lo, g: b[i] + s[i] };
  }
  const out = { site: best };
  if (best) {
    const { x: cx, y: cy } = best;
    // level the block, then carve a canyon 20 m deep: in along row cy-3, round a loop to the east,
    // and back out along row cy+3, so a wall 3 cells thick separates the two legs west of the loop
    const top = best.g - 2;
    e.beginStroke();
    for (let k = 0; k < 30; k++) for (let oy = -10; oy <= 10; oy += 4) for (let ox = -26; ox <= 20; ox += 4) e.sculpt('flatten', { x: cx + ox, y: cy + oy, radius: 4, intensity: 4, target: top });
    const bed0 = top - 20, path = [[cx - 22, cy - 3], [cx + 12, cy - 3], [cx + 12, cy + 3], [cx - 22, cy + 3]];
    const L = path.slice(1).reduce((acc, p, k) => acc + Math.hypot(p[0] - path[k][0], p[1] - path[k][1]), 0);
    let sDone = 0;
    for (let k = 1; k < path.length; k++) {
      const [ax, ay] = path[k - 1], [bx, by] = path[k], len = Math.hypot(bx - ax, by - ay);
      for (let t = 0; t < len; t += 1) {
        const t1 = Math.min(len, t + 1);
        const za = bed0 - 4 * (sDone + t) / L + 1.2, zb = bed0 - 4 * (sDone + t1) / L + 1.2;
        e.sculpt('channel', { ax: ax + (bx - ax) * t / len, ay: ay + (by - ay) * t / len, x: ax + (bx - ax) * t1 / len, y: ay + (by - ay) * t1 / len, radius: 2, intensity: 0.2, za, zb });
      }
      sDone += len;
    }
    await e.endStroke();
    // a stream runs through it
    sim.brush('flood', { x: cx - 22, y: cy - 3, radius: 1.5, intensity: 0.01, days: 0.3 });
    await e.run(2, { batchDays: 0.02 });
    const w0 = await e.readLayer('water');
    out.wetIn = w0[(cy - 3) * N + cx - 10]; out.wetOut = w0[(cy + 3) * N + cx - 10];
    // make the break-through certain now (a test cannot wait for chance), then look for it
    const P = e.arches.params, keep = P.pBridge;
    P.pBridge = 1e3;
    e.arches.lastDay = e.day - 300 * 365;
    await e.arches.update(e);
    P.pBridge = keep;
    const a = sim.archStats();
    const br = e.arches.list.find((q) => q.kind === 'bridge' && Math.abs(q.y - cy) <= 2 && q.x < cx && q.x > cx - 22);
    out.bridges = a.list.filter((q) => q.kind === 'bridge');
    out.necks = a.necks;
    // the stream goes on through the cut: water under the bridge
    sim.brush('flood', { x: cx - 22, y: cy - 3, radius: 1.5, intensity: 0.01, days: 0.3 });
    await e.run(1, { batchDays: 0.02 });
    const w1 = await e.readLayer('water');
    out.waterUnder = br ? w1[br.y * N + br.x] : 0;
    const st = await sim.stats();
    books.push({ run: 'bridge', ok: booksOk(st), bal: st.balanceErrorPct, solids: st.solidsError_m3, archRock: st.archRock_m3 });
    check('bridge', !!br && out.waterUnder > 0.01, out);
  } else check('bridge', false, out);
}

check('books', books.every((q) => q.ok), { books });
R.minutes = (performance.now() - t0) / 60000;
R.gpuErrors = window.__gpuErrors || 0;
R.gpuErrorMsgs = window.__gpuErrorMsgs || [];
check('noGpuErrors', R.gpuErrors === 0, { errors: R.gpuErrors });
R.passed = Object.values(R.checks).filter((c) => c.pass).length + '/' + Object.keys(R.checks).length;
return R;
