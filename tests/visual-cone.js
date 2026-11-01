// Harness: node scripts/launch.cjs --eval=tests/visual-cone.js --out=tests/out-visual.json --shot=tests/shot.png
// Runs the cone for 1000 years and leaves the "change" overlay on for a screenshot.
await sim.load('cone', { size: 512, seed: 1, preset: 'Colorado alpine' }); sim.pause();
await sim.run(365000);
sim.renderer.overlay = window.__overlay || 'change';
const s = await sim.stats();
return { maxErosion: s.maxErosion_m, maxDep: s.maxDeposition_m, maxDepth: s.maxWaterDepth };
