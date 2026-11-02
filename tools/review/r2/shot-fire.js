(async () => { const S = window.sim; S.pause(); await S.load('random', { size: 512, seed: 7, preset: 'Colorado alpine' }); S.pause(); await S.run(365 * 50 + 150);
  S.brush('wildfire', { x: 256, y: 300, radius: 60, intensity: 1, days: 3 }); await S.run(365 + 30); S.pause(); await new Promise(r => setTimeout(r, 2500)); return 'ok'; })()
