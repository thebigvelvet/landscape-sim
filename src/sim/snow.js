// Snow: accumulation when cold, positive-degree-day melt with a diurnal cycle, sublimation.
//
// The per-day physics lives in SNOW_WGSL and is executed inside the fused column kernel
// (column.js) so snow, frozen ground and infiltration see each other every sub-day. `step()`
// encodes that column kernel (deduplicated per frame, so calling snow.step and freezethaw.step
// in the same frame dispatches it once).
import { column } from './column.js';

export const SNOW_PARAMS = {
  ddf: 0.0045,      // m water / (degC day)  (4.5 mm/degC/day, typical for open snow)
  sublim: 0.0002,   // m/day sublimation while T < 0
};

export const SNOW_WGSL = /* wgsl */`
// Expected positive part of temperature over a day with uniform diurnal range dtr.
fn pdd(T : f32) -> f32 {
  let a = max(0.5 * P.dtr, 0.1);
  if (T - a >= 0.0) { return T; }
  if (T + a <= 0.0) { return 0.0; }
  return (T + a) * (T + a) / (4.0 * a);
}
// returns (newSWE, liquid water released = rain + melt, sublimation loss)   all in metres
fn snowStep(swe : f32, T : f32, precip : f32, dt : f32) -> vec3<f32> {
  let sf = clamp((1.5 - T) / 3.0, 0.0, 1.0);          // rain/snow transition -1.5..+1.5 degC
  let snowfall = precip * sf;
  let rain = precip - snowfall;
  var s = swe + snowfall;
  let melt = min(s, P.ddf * pdd(T) * dt);
  s = s - melt;
  let sub = min(s, P.sublim * dt * select(0.0, 1.0, T < 0.0));
  s = s - sub;
  return vec3<f32>(s, rain + melt, sub);
}
`;

export default {
  name: 'snow',
  init(device, world) { column.init(device, world); },
  step(encoder, dtDays, climate) { column.step(encoder, dtDays, climate); },
};
