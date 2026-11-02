// Screenshot: plants after 50 years + summer, Utah desert (none overlay).
await sim.load('random', { size: 512, seed: 4, preset: 'Utah desert' }); sim.pause();
await sim.run(50 * 365 + 190);
sim.setOverlay('none');
sim.renderer.camera.dist *= 0.8;
await new Promise((r) => setTimeout(r, 800));
return await sim.stats().then((s) => ({ meanVeg: s.meanVeg, covered: s.vegCoveredFrac, balance: s.balanceErrorPct }));
