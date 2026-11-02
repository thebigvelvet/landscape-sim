const e = sim.engine;
sim.pause(); await sim.load('random', { size: 512, seed: 2, preset: 'Colorado alpine' }); sim.pause();
await sim.refreshHeights(); await new Promise(r=>setTimeout(r,300));
const cv = sim.renderer.canvas; const rect = cv.getBoundingClientRect(); const out = [];
for (let fy = 0.3; fy <= 0.8; fy += 0.125) for (let fx = 0.45; fx <= 0.9; fx += 0.15) {
  const px = rect.left + fx * rect.width, py = rect.top + fy * rect.height;
  const p = sim.pick(px, py); if (!p) { out.push({px,py,miss:true}); continue; }
  const b = sim.screenOf(p.x, p.y); out.push({ px: Math.round(px), py: Math.round(py), cell: [p.x.toFixed(1), p.y.toFixed(1)], err: Math.hypot(b.x-px,b.y-py).toFixed(2) });
}
for (const [tx,ty] of [[300,330],[256,256]]) { const sp = sim.screenOf(tx,ty); const p = sim.pick(sp.x, sp.y); out.push({target:[tx,ty], got:[p?.x, p?.y]}); }
return out;
