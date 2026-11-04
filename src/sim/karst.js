// Karst valleys: how sinkholes grow, join up and widen into closed karst valleys.
//
// The column kernel (sim/column.js) already dissolves soluble rock everywhere groundwater sits in it
// (slow, even lowering, plus collapse over buried salt or limestone). This pass adds the two
// processes that turn scattered sinkholes into valleys:
//
//   1. Point recharge. Rain on bare limestone mostly runs a short way and then sinks at the lowest
//      spot. Water that has just come in from the air is aggressive (full of carbon dioxide, far
//      from saturated), so most of the dissolving happens right where it sinks. The column kernel
//      records how much surface water sank into the ground in each cell this batch (karst.y) and
//      here it dissolves rock in proportion. A hollow catches more runoff than the ground around
//      it, so it sinks more water and deepens faster: dolines (sinkholes) grow and those close
//      together merge into one long hollow (an uvala).
//   2. Corrosion at the foot of the walls. Where a hollow's floor is wet (flood water or a full
//      groundwater store in its sediment) the limestone wall next to it dissolves at its foot,
//      so the wall retreats and the floor widens. Once a hollow has dissolved down to an
//      insoluble bed, or to the water table, it cannot go deeper, but it keeps widening: a flat-
//      floored polje (a large closed karst valley) lined up along the contact. Floors flood after
//      big storms and drain again through swallow holes (ponors).
//
// Swallow holes: the cumulative dissolved depth (karst.x) also opens conduits, so the column
// kernel sinks surface water faster where a lot of rock has already gone.
//
// Real karst valleys take hundreds of thousands of years. Both processes run KARST_SPEEDUP times
// faster than measured rates so a valley shows within a few tens of thousands of years at the
// fastest speed setting (the plain dissolution in column.js is not sped up).
//
// world.karst (vec4 per cell): (rock dissolved so far m, surface water sunk this batch m, 0, 0).
// Dissolved rock leaves in solution and is logged with the sediment out of the map (acc.w), so the
// solids books stay closed.
import { COMMON_WGSL, makeKernel, dispatchGrid } from './common.js';

export const KARST_SPEEDUP = 20;
export const KARST_PARAMS = {
  // m of limestone dissolved per m of water sunk: ~0.25 kg/m3 of calcium carbonate carried away by
  // aggressive recharge, at 2700 kg/m3 of rock -> 1e-4, sped up
  kRech: 1e-4 * KARST_SPEEDUP,
  // m/yr of limestone lost at the foot of a wall that stands in a wet hollow floor, sped up
  kFoot: 5e-4 * KARST_SPEEDUP,
};

const KARST_WGSL = /* wgsl */`
${COMMON_WGSL}
@group(0) @binding(1) var<storage, read_write> bedrock : array<f32>;
@group(0) @binding(2) var<storage, read> soil : array<f32>;
@group(0) @binding(3) var<storage, read> water : array<f32>;
@group(0) @binding(4) var<storage, read> groundwater : array<f32>;
@group(0) @binding(5) var<storage, read_write> acc : array<vec4<f32>>;
@group(0) @binding(6) var<storage, read_write> karst : array<vec4<f32>>;

@compute @workgroup_size(16, 16)
fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
  let N = i32(P.N);
  let x = i32(gid.x); let y = i32(gid.y);
  if (x >= N || y >= N) { return; }
  let i = idx(x, y);
  var k = karst[i];
  if (P.strataOn < 0.5 || P.yrsE <= 0.0) { return; }
  // the sinking water dissolves the rock over a few cells round the swallow hole, not in one cell
  // (karst.y is written fresh by the column kernel every batch and only read here)
  var sunk = 0.25 * k.y;
  for (var oy = -1; oy <= 1; oy++) {
    for (var ox = -1; ox <= 1; ox++) {
      if (ox == 0 && oy == 0) { continue; }
      let wgt = select(0.0625, 0.125, ox == 0 || oy == 0);
      sunk += wgt * karst[idxc(x + ox, y + oy)].y;
    }
  }
  let br = bedrock[i];
  let so = soil[i];
  // soluble rock at the surface or just under a thin cover (the water reaches it through the soil)
  let solS = min(max(rockExtra(br, x, y).x, 0.5 * rockExtra(br - 4.0, x, y).x), 3.0);
  if (solS <= 0.0) { return; }
  let z = br + so;
  // 1. point recharge. A pit already well below the ground around it fills with rubble and soil
  // faster than it deepens, so it widens instead.
  var zm = 0.0;
  zm += bedrock[idxc(x - 1, y)] + soil[idxc(x - 1, y)] + bedrock[idxc(x + 1, y)] + soil[idxc(x + 1, y)];
  zm += bedrock[idxc(x, y - 1)] + soil[idxc(x, y - 1)] + bedrock[idxc(x, y + 1)] + soil[idxc(x, y + 1)];
  let pit = max(0.25 * zm - z, 0.0);
  var dd = P.kRech * solS * max(sunk, 0.0) / (1.0 + pit / 3.0);
  // 2. corrosion at the foot of a wall standing in a wet hollow floor
  var foot = 0.0;
  let nx = array<i32, 4>(x - 1, x + 1, x, x);
  let ny = array<i32, 4>(y, y, y - 1, y + 1);
  for (var q = 0; q < 4; q++) {
    if (nx[q] < 0 || nx[q] >= N || ny[q] < 0 || ny[q] >= N) { continue; }
    let j = idx(nx[q], ny[q]);
    let zn = bedrock[j] + soil[j];
    let low = clamp((z - zn - 0.5) / 4.0, 0.0, 1.0);          // this cell stands above the floor
    let wet = max(select(0.0, 1.0, water[j] > 0.03), clamp(groundwater[j] / gwCapRock(soil[j], solS) - 0.5, 0.0, 0.5) * 2.0);
    foot = max(foot, low * wet);
  }
  dd += P.kFoot * solS * foot * P.yrsE;
  dd = min(dd, 0.5);
  if (dd > 0.0) {
    let nb = br - dd;
    bedrock[i] = nb;
    let got = br - nb;
    acc[i] = acc[i] + vec4<f32>(0.0, 0.0, 0.0, got);
    karst[i] = vec4<f32>(k.x + got, k.y, k.z, k.w);
  }
}
`;

class KarstKernel {
  init(device, world) {
    if (this.world === world && this.k) return;
    this.world = world;
    const B = world.buffers;
    this.k = makeKernel(device, 'karst', KARST_WGSL, ['rw', 'r', 'r', 'r', 'rw', 'rw']);
    this.bg = this.k.bind(world.params.buffer, [B.bedrock, B.soil, B.water, B.groundwater, B.acc, B.karst]);
  }
  record(pass) {
    pass.setPipeline(this.k.pipeline); pass.setBindGroup(0, this.bg); dispatchGrid(pass, this.world.N);
  }
}
export const karst = new KarstKernel();
