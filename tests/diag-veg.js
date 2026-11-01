const res = {};
for (const preset of ['Utah desert', 'Colorado alpine', 'Pacific NW wet', 'Temperate']) {
await sim.load('random', { size: 256, seed: 3, preset });
sim.pause();
const e = sim.engine;
const veg = await e.readLayer('veg'), soil = await e.readLayer('soil'), plant = await e.readLayer('plant'), br = await e.readLayer('bedrock');
const N = e.N; const q = (a) => { const s = Array.from(a).sort((x, y) => x - y); return [0.05, 0.25, 0.5, 0.75, 0.95].map((p) => +s[Math.floor(p * (s.length - 1))].toFixed(3)); };
const m = new Float32Array(N * N), wd = new Float32Array(N * N); for (let i = 0; i < N * N; i++) { m[i] = plant[4 * i + 1]; wd[i] = plant[4 * i]; }
// cover vs elevation bands
const z = new Float32Array(N * N); for (let i = 0; i < N * N; i++) z[i] = br[i] + soil[i] + e.datum;
const zs = Array.from(z).sort((a,b)=>a-b); const bands = [0, 0.2, 0.4, 0.6, 0.8, 1].map(p => zs[Math.floor(p*(zs.length-1))]);
const byZ = []; for (let b = 0; b < 5; b++) { let sv = 0, sw = 0, n = 0; for (let i = 0; i < N*N; i++) if (z[i] >= bands[b] && z[i] <= bands[b+1]) { sv += veg[i]; sw += wd[i]*veg[i]; n++; } byZ.push([Math.round(bands[b]), +(sv/n).toFixed(2), +(sw/n).toFixed(2)]); }
const sl = new Float32Array(N*N); for (let y=1;y<N-1;y++) for (let x=1;x<N-1;x++){const i=y*N+x; sl[i]=Math.hypot(z[i+1]-z[i-1], z[i+N]-z[i-N])/(2*e.cellSize);} res[preset] = { veg: q(veg), moist: q(m), woody: q(wd), slope: q(sl), byZ };
}
return res;
