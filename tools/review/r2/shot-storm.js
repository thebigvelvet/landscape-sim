(async () => { const S = window.sim; S.pause(); await S.load('random', { size: 512, seed: 7, preset: 'Temperate' }); S.pause(); await S.run(365 * 30 + 180);
  S.setSpeed(1); S.play(); S.brush('storm', { x: 256, y: 256, radius: 70, intensity: 1, days: 3 }); await new Promise(r => setTimeout(r, 2200)); return 'ok'; })()
