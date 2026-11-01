// Harness: --eval=tests/visual-run.js --shot=tests/shot-run.png
// Plays a scenario live for a while and leaves it running with an overlay, for a screenshot.
const scen = window.__scen || 'valley', preset = window.__preset || 'Pacific NW wet';
await sim.load(scen, { size: 512, seed: 3, preset });
sim.setSpeed(window.__speed || 3650); sim.play();
sim.renderer.overlay = window.__overlay || 'water';
await new Promise((r) => setTimeout(r, (window.__secs || 12) * 1000));
const s = await sim.stats();
return { year: s.year, maxDepth: s.maxWaterDepth, ero: s.maxErosion_m, nan: s.hasNaN, times: sim.gpuTimes };
