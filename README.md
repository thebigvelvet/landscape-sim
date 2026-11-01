# Landscape Time-Lapse

A 3D landscape you can rain on, freeze, thaw and erode, from 1 day per second up to 1000 years per
second. All of the simulation runs on the graphics card (WebGPU compute shaders).

**To run it, double-click `start.bat`** (or the "Landscape Time-Lapse" shortcut on the desktop).

## Where the parts came from

This is the round-1 combination of three competing builds:

| Part | From | Why |
|---|---|---|
| Engine: water flow, erosion, time scaling, speed dial, launcher, self-test | Engineer | Carved real branching stream networks; fastest (1000 years in ~5 s, 1024² at 60 fps); most robust launcher |
| Rendering: rock strata, talus, soil, vegetation, snow, translucent flowing water, shadows, sky, rain/snow | Artist | By far the best looking |
| Control panel, place cards, tooltips, date/weather card, legends | Artist | Plain-language, easiest to use |
| Lateral groundwater with springs (`src/sim/groundwater.js`) | Physicist | Water soaks in, creeps downhill underground, and emerges in hollows |
| Sunny vs shady slopes for snowmelt and temperature | Physicist | Snow lingers on north faces into June |
| Wet/dry storm spells (Markov weather) | Physicist | Rain comes in storms, not as a constant drizzle |

Checks run on the combined build (RTX 4060 Ti, Electron 45):
- Cone, Colorado alpine, 1000 years: water balance error -0.00004 %, no NaN, about 5 s.
- Every review scenario (cone 1000 yr, valley, random 10,000 yr, Utah desert 2000 yr,
  temperate 200 yr): water balance within 0.0004 %, no NaN.
- 1024² random terrain at 1000 years/s: 60 fps.
- Snow on the cone in mid-May: north faces 92 % covered, south faces 3 %. Mid-June: 20 % vs 0 %.
- Groundwater in late summer: hollows 41 % full, ridges 32 %; about 1.6 % of the ground has springs.

The rest of this file is the Engineer build's engine documentation, updated for the combined build.

## Running it

- **Desktop app:** double-click `start.bat`. On the first run it installs dependencies, downloads
  the Electron runtime and builds the page. After that it only rebuilds when the source has changed.
  If Node.js is missing, it opens the download page and tells you what to do. If WebGPU is
  unavailable, the app explains how to fix it (usually a graphics driver update).
- **Browser:** `npm install`, then `npm run dev`, then open http://localhost:5173 in Chrome or Edge 113+.
  URL parameters: `?scenario=cone&preset=Colorado%20alpine&size=512&seed=1` (also `speed=` in days/s and `paused=1`).
- `npm run app` does the same as `start.bat`.
- **Self-test on the real GPU:** `node scripts/launch.cjs --selftest` runs the cone for 1000 years
  plus `sim.bench()` and writes `selftest-results.json`. `--eval=<file.js> --out=<file.json> [--shot=<png>]`
  runs any test script in `tests/` and can also save a screenshot.

Note: Chrome on Windows ignores `powerPreference`, so on a laptop with two GPUs the browser may pick
the integrated one (the reviewer's browser pane reported AMD RDNA2 graphics). The Electron app
forces the discrete GPU (`force_high_performance_gpu`) and reported NVIDIA Lovelace (RTX 4060 Ti).
The panel shows which adapter is in use.

### Test hook (`window.sim`)
`load(scenario, {size, seed, preset, cellSize, ruggedness, relief})`, `run(days, {batchDays?, nSub?})`,
`setSpeed(daysPerSec)`, `pause()`, `play()`, `stats()`, `bench(sizes?)`. Also `sim.engine` (the
Simulation, including `readLayer(name)` for tests) and `sim.gpuTimes`.
`stats()` returns all of the required fields, plus `totalGroundwater_m3`, `balanceError_m3`/`balanceErrorPct`,
`cumSedimentOut_m3`, `solidsError_m3`, `maxErosion_m`, `maxDeposition_m`, `maxWaterDepth`, `dtH`,
`morph` and `routingIntensity`.

**Water balance:** `cumPrecip = (water + snowSWE + groundwater − initial) + cumOutflow + cumEvapLoss`.
Groundwater is a store and is counted as one. `cumOutflow` includes both boundary outflow and
"fast runoff" (see below).

## Layout
```
src/main.js            bootstrap, frame loop, sub-step governor, window.sim
src/world.js           N×N grid, one f32 storage buffer per layer (contract names) + engine extras
src/terrain.js         random (fBm + ridged + domain warp + droplet pre-erosion), cone, valley
src/gpuTimer.js        timestamp-query pass timing for the governor
src/sim/params.js      ONE shared uniform block, written once per frame
src/sim/scheduler.js   multi-rate time stepping, run(), stats()
src/sim/climate.js     presets, seasonal curves, lapse rate, storms (CPU + WGSL mirror)
src/sim/snow.js        snow accumulation, degree-day melt (WGSL fn)
src/sim/freezethaw.js  frost depth, F/T cycles, weathering, frozen-ground infiltration (WGSL fn)
src/sim/column.js      fused per-cell kernel composed from climate/snow/freezethaw/water-vertical
src/sim/water.js       virtual-pipe shallow water + conservative sediment transport
src/sim/groundwater.js lateral Darcy flow of groundwater, springs where the ground saturates
src/sim/erosion.js     capacity erosion/deposition (sub-step hook) + talus/creep/rock fall
src/sim/stats.js       GPU reductions, flux log ring, async readback
src/render/            raw WebGPU renderer from the Artist build (shaders.js, lighting.js for shadows/AO) + orbit camera
src/ui/panel.js        side panel, date card, time bar (layout from the Artist build); legend.js
electron/main.cjs      app:// protocol, GPU switches, self-test/eval harness
scripts/launch.cjs     download Electron if needed, rebuild if stale, launch
tests/                 harness scripts + their recorded outputs
```
Every module exports `{ name, init(device, world), step(encoder, dtDays, climate) }`. Two things to
know when swapping modules:
- `water.step` owns the hydraulic sub-step loop. `erosion.init` registers its exchange kernel as a
  per-sub-step hook (`world.substepHooks`), and `erosion.step` does the once-per-frame thermal work.
- `snow.step` and `freezethaw.step` both dispatch the fused column kernel, deduplicated per frame.
  The physics of each lives in its own file as a WGSL function, and `column.js` composes them.

## Design per module

- **World:** contract buffers `bedrock, soil, water, sediment, snowSWE, frostDepth, temp, velX, velY, flux(×4)`.
  The extras are `water2`/`sediment2` (ping-pong), `groundwater`, `slope`, `acc` (per-cell flux
  accumulators), `initHeight` (base level and change overlay) and scratch buffers. Heights are stored
  relative to a datum (the preset's base elevation) to keep f32 precision. The datum is added back
  for the lapse rate and in `stats()`.
- **Water:** virtual pipes. The pipe area is `dx·h̄`, which makes this a real shallow-water
  discretisation, and the pipe depth is capped at `(0.5dx/dt)²/g`. Together with the velocity cap
  `0.5dx/dt`, this keeps both the gravity-wave and advective Courant numbers at or below 0.5 for any
  depth. Lakes do not slosh in a checkerboard pattern, and stability needs no feedback from stats.
  Manning friction is applied implicitly, and K-scaling keeps depths non-negative. Boundary cells
  drain to an outside held at the edge's **initial height** (a fixed base level), so an edge cell
  cannot cut itself down without limit. Sediment moves with the water: each pipe carries the same
  fraction of the cell's sediment as of its water. This is exactly conservative, and what leaves
  through the edges is logged.
- **Erosion:** capacity `C = kc·|v|·S·min(h,1.5)·limiter(h)·MORPH` (linear in discharge). S is the
  **steepest descent from the cell itself**, not a central difference. With a central difference a
  pit still sees a slope and digs itself deeper, which caused checkerboard pits early in development.
  Sediment is stored as bed-equivalent volume, so bed and suspended sediment swap exact amounts.
  Solids stay conserved even when MORPH changes as you move the speed dial. Per sub-step there is a
  morphological CFL limit: no cell can lose more than dzMax = 0.02·dx in one step, or more than half
  of its drop to the downhill neighbour. Thermal processes use a race-free 8-neighbour gather: talus
  failure above 37°, linear creep (stability-clamped) and rock fall above 65°. Exact f32 differences
  are used wherever bedrock changes.
- **Column (snow + freeze/thaw + soil water):** one fused kernel per frame. It sub-steps the frame's
  climate interval at up to 1-day resolution (at most 48 inner steps) entirely in registers. Snow
  uses a rain/snow ramp over −1.5…+1.5 °C, positive-degree-day melt with a diurnal range, and
  sublimation. Frost depth follows a Stefan-like rate, damped by depth and insulated by snow.
  Freeze/thaw cycles come from the diurnal 0 °C crossing. Frozen ground cuts infiltration by up to
  92%. Groundwater gains infiltration and loses ET and baseflow. Weathering converts bedrock to soil,
  driven by frost cycles plus a slow chemical term, and is shielded by soil cover.
- **Climate:** cosine seasonal temperature and precipitation curves, a lapse rate, orographic
  enhancement, and four presets with base elevations (Utah 1400 m, Colorado 2900 m, PNW 150 m,
  Temperate 300 m). The temperature, precipitation and seasonality sliders apply on top of the preset.
  "Big storm" adds 3 storm-days at 12× precipitation, averaged correctly when one frame spans years.

## Time scaling (multi-rate scheme)

Each frame, or each batch in `run()`, uses three clocks:

1. **Climate, `Dcol` days.** The column kernel integrates these exactly at sub-day resolution. Frames
   of a year or longer integrate a representative year **twice**. Year 1 removes the transient from
   the starting state and year 2 is the periodic cycle. Only a genuine secular trend, perennial snow
   (glacier mass balance), is extrapolated over the remaining years. Fluxes are then rescaled so that
   `P = ΔStorage + runoff + ET` holds exactly. Weathering is integrated over true time and needs no
   acceleration factor.
2. **Hydraulics, `τ = nSub · dtH` seconds.** `dtH = 0.2·dx` is fixed and CFL-safe (see Water).
   `nSub` is set by the **GPU-time governor**, which uses timestamp queries to keep sim plus render
   GPU time near 11 ms per frame (up to 256/128/64 sub-steps at 256/512/1024). Runoff enters at a
   routing intensity `aW = min(A, 150)`, where `A = Dcol·86400/τ`. A fraction `fR = aW/A` of the
   runoff is routed. The rest is "fast runoff", event flow that leaves the basin within the frame,
   and is logged as outflow. Open-water evaporation and channel transmission loss scale the same way
   and are depth-gated, so the result does not depend on how runoff is spread in time.
3. **Landscape, `Deros` days.** Fluvial erosion uses a morphological factor `MORPH = Deros·86400/(aW·τ)`.
   Because capacity is linear in discharge, `MORPH × (aW × real flow) × τ` equals the real erosion
   over `Deros`. Hillslope processes integrate `Deros` directly in unconditionally stable forms.

At 1 day/s, A is small enough that all runoff is routed and MORPH is about 1, so the hydrology runs
in real time. At 1000 years/s, MORPH is about 10⁵, capped per cell by the morphological CFL.

**Seasons at high speed:** above 20 days per frame the display is stroboscopic. Each frame advances
whole years plus about 1.5 days of phase, so snow and seasons cycle smoothly on screen (about one
year per 4 s) instead of flickering, while time advances at the requested rate. The HUD then reads
"seasons sampled". Erosion uses the smooth requested `Deros`, so landscape change is not lumpy.

**`run(days)`** picks batch lengths so the hydraulic solver gets about 96k sub-steps in total, which
is enough for drainage networks to establish, and never more than 6083 days per batch.

**Evidence that the time scaling is principled** (`tests/out-consistency.json`): the cone over 300
years with batches of 10 days (MORPH 90) and 60 days (MORPH 540) gives sediment yield 15,140 vs
14,263 m³ and maximum incision 2.16 vs 2.18 m. That is 6% agreement across a 6× difference in
acceleration. Water balance error is below 1e-4% in both cases.

## Measured results (RTX 4060 Ti, Electron 45, `selftest-results.json`)

**Cone, 512², Colorado alpine, `sim.run(365000)` (1000 years):**
- Water balance error: −6,447 m³ of 2.105e10 m³ precipitation, **−3.1e-5 %**
- No NaN
- Solids audit error: 254 m³ (sediment yield 59,332 m³)
- Maximum incision 3.3 m, maximum deposition 1.6 m
- Wall time: 7.6 s

**`sim.bench()`:**

| grid | hydraulic sub-steps/s (no render) | ms/sub-step | Mcell-updates/s | fps at 1 yr/s with render | sub-steps/frame (governor) |
|---|---|---|---|---|---|
| 256² | 59,600 | 0.017 | 3,900 | 60 | 256 (cap) |
| 512² | 11,700 | 0.085 | 3,080 | 60 | 128 (cap) |
| 1024² | 2,190 | 0.46 | 2,290 | 60 | 18 |

**Interactive stress test** (`tests/out-interactive.json`): 1024², random terrain, 1000 years/s for
20 s. That is 20,000 simulated years at a steady 58–60 fps, with sim 9.8 ms and render 0.9 ms of GPU
time per frame, balance error 1e-8 %, and no NaN.

**Stability matrix** (`tests/out-matrix.json`): every combination of 3 scenarios and 4 presets,
each run both at 1-minute batches (real-time hydrology) and at 6083-day batches (1000 yr/s) for 5000
years. No NaN in any case, and every balance error was below 5e-4 %.

## Known weaknesses
- At high speed, flows are routed at a capped intensity of 150× and the rest leaves as fast runoff.
  Closed basins therefore under-fill at high speed: in reality fast runoff would pond there.
- Erosion constants are calibrated to look plausible (a few metres of incision per 1000 years), not
  fitted to field data. The "Erosion rate" slider scales them.
- Snow does not redistribute (no wind drift or avalanches), and glaciers accumulate but do not flow.
- Groundwater flows only through a shallow store of fixed capacity per preset; there is no deep aquifer.
- The f32 solids audit drifts slightly over very long runs (hundreds of m³ against 10⁵–10⁷ m³ of
  sediment moved).
- At 1024², the per-sub-step cost exceeds L2 cache and becomes DRAM-bandwidth bound (5.4× the cost
  of 512² rather than 4×).
- Random terrain at 1024² takes about 3 s to generate on the CPU.
- The overlay buttons do not highlight when the overlay is changed through the API.

## What I'd do next
- Fuse the erosion exchange into the water update kernel, and store flux as f16, to cut DRAM traffic
  at 1024² by about 25%.
- Generate terrain on the GPU or in a worker.
- Stochastic storm sampling for the routed fraction, so floods are episodic rather than continuous.
- Glacier flow (shallow-ice) and snow avalanching (the Artist build has an avalanche kernel to port).
