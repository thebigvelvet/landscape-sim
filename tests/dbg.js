await sim.load('random', { size: 256, seed: 5, preset: 'Pacific NW wet' }); sim.pause();
await sim.run(365 * 300, { batchDays: 365000 / 60 });
const E = sim.engine;
const v = await E.readLayer('veg'), e = await E.readLayer('eco'), so = await E.readLayer('soil'), w = await E.readLayer('water');
const hist = new Array(11).fill(0); let wet = 0, thin = 0, lowT_wet = 0, lowT_thin = 0, lowT = 0;
for (let i = 0; i < v.length; i++) { const T = e[4*i]; hist[Math.min(10, Math.floor(T * 10))]++; if (w[i] > 0.08) wet++; if (so[i] < 0.3) thin++; if (T < 0.5) { lowT++; if (w[i] > 0.08) lowT_wet++; if (so[i] < 0.3) lowT_thin++; } }
return { hist, wet: wet / v.length, thin: thin / v.length, lowT: lowT / v.length, lowT_wet: lowT_wet / v.length, lowT_thin: lowT_thin / v.length };
