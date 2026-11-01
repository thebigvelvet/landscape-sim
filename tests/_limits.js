const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
const L = {}; for (const k in a.limits) L[k] = a.limits[k];
const d = window.sim.engine.device; const DL = {}; for (const k in d.limits) DL[k] = d.limits[k];
return { adapter: L, device: DL, info: window.sim.adapterInfo && { v: window.sim.adapterInfo.vendor, a: window.sim.adapterInfo.architecture } };
