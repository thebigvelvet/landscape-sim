// Screenshot: Storm tool selected, cursor ring on the land, a running storm (cloud shadow + dashed ring) at 1 day/s.
await sim.load('random', { size: 512, seed: 4, preset: 'Colorado alpine' }); sim.pause();
await sim.run(20 * 365 + 200);
sim.setTool('storm');
sim.brush('storm', { x: 300, y: 260, radius: 45, days: 3 });
sim.brush('flood', { x: 180, y: 330, radius: 8 });
sim.renderer.brush = { x: 200, y: 200, r: 40, tool: 1 };
sim.setSpeed(1); sim.play();
await new Promise((r) => setTimeout(r, 2500));
sim.pause();
sim.renderer.brush = { x: 200, y: 200, r: 40, tool: 1 };
return { events: (await sim.stats()).events };
