// Freeze/thaw: frost depth follows air temperature (Stefan-like, insulated by snow), diurnal
// freeze-thaw cycles weather bedrock into soil (frost shattering, strongest on bare wet rock with
// thin soil), and frozen ground cuts infiltration so more water runs off.
//
// Like snow, the per-day physics is in FREEZETHAW_WGSL and runs inside the fused column kernel.
import { column } from './column.js';

export const FREEZETHAW_PARAMS = {
  frostK: 0.008,     // m per (degC day) of frost penetration (before depth/snow damping)
  thawK: 0.012,      // m per (degC day) thaw
  kWeather: 4e-6,    // m of bedrock converted per freeze-thaw cycle (bare, wet rock)
  kChem: 2e-5,       // m/yr baseline (chemical) weathering under thin soil
};

export const FREEZETHAW_WGSL = /* wgsl */`
fn frostStep(d : f32, T : f32, swe : f32, dt : f32) -> f32 {
  let insul = 1.0 / (1.0 + swe / 0.04);          // ~4 cm SWE halves frost penetration
  var nd = d;
  if (T < 0.0) { nd = nd + dt * P.frostK * (-T) * insul / (1.0 + 3.0 * d); }
  else { nd = nd - dt * P.thawK * T; }
  return clamp(nd, 0.0, 3.0);
}
// 0..1, how much the frozen layer blocks infiltration
fn frozenFactor(d : f32, T : f32) -> f32 {
  return smoothstep(0.02, 0.15, d) * select(0.6, 1.0, T < 1.0);
}
// expected number of freeze-thaw (0 degC crossing) cycles in dt days
fn ftCycles(T : f32, dt : f32) -> f32 {
  let a = max(0.5 * P.dtr, 0.1);
  return dt * clamp(1.0 - abs(T) / a, 0.0, 1.0);
}
// metres of bedrock converted to soil; humped/exponential soil-production with soil cover.
// Plants: a canopy and litter layer insulate the surface (fewer, weaker freeze-thaw cycles, about
// half under full cover), while roots, fungi and organic acids speed chemical weathering ~3x
// (biotic weathering; soil production of 0.05-0.1 mm/yr under forest, Heimsath et al. 1997).
fn weathering(cycles : f32, moisture : f32, soil : f32, dt : f32, veg : f32) -> f32 {
  let shield = exp(-soil / 0.6);
  let frost = P.kWeather * cycles * (1.0 - 0.5 * veg) * (0.3 + moisture);
  let chem = P.kChem * dt / 365.0 * (0.2 + moisture) * (1.0 + 2.0 * veg);
  return (frost + chem) * shield;
}
`;

export default {
  name: 'freezethaw',
  init(device, world) { column.init(device, world); },
  step(encoder, dtDays, climate) { column.step(encoder, dtDays, climate); },
};
