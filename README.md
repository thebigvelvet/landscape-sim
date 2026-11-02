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

## Round 2 (Engineer build): plants, soil and weather brushes

**Branch `r2-engineer`.** One command runs the whole round-2 suite on the real GPU and prints PASS/FAIL:

```
node scripts/launch.cjs --eval=tests/round2.js --out=tests/out-round2.json      (or: npm test)
```

It exits non-zero if anything fails. To run a subset, prepend `window.__only = ['name', ...];` to the script.
Scripted runs now use their own Electron profile and skip the single-instance lock, so a test can run
while the app (or another test) is open.

### What was added
| File | What |
|---|---|
| `src/sim/vegetation.js` | Plant cover `veg` and burn severity `burn`; closed-form growth and dieback per batch; writes the derived fields that other kernels need |
| `src/sim/events.js` | Storm, Drought, Flood and Wildfire: the event list, the events uniform, and the wildfire ignition and spread kernels |
| `src/sim/pick.js` | GPU ray picking against the exact rendered triangle mesh, plus a float64 CPU reference for the tests |
| `src/ui/brushes.js` | Tool behaviour on the canvas: click, drag to steer, cursor ring |
| `src/sim/column.js` | Plants change infiltration, transpiration and weathering; groundwater capacity depends on soil depth; growing-season soil moisture for the plants; brushed storms and floods enter here |
| `src/sim/scheduler.js` | `_advance` splits batches at event boundaries; 400-year plant spin-up on load; `brush()`; new stats |
| `src/sim/erosion.js`, `groundwater.js`, `stats.js`, `render/*`, `ui/*` | Feedbacks, springs limited by soil capacity, plant statistics, plant drawing, Plants overlay, cursor and event rings, tool row |

New layers:
- `veg`, `burn` and `erodMul` (f32).
- `vegAux` (vec4): growing-season moisture W, infiltration multiplier, a copy of veg, and the ground
  height at the last burial check.
- `fire`: scratch space for fire spread.
- `light` is now two vec4 per cell. `[2i+1]` holds veg, burn, drought stress and warmest-month
  temperature for the renderer.

**Every kernel and the terrain vertex stage still use at most 8 storage buffers.** That is why the column
kernel reads plant data from `vegAux`, and why `temp` is now written by the vegetation kernel.

### Plants and soil (model)
- **Carrying capacity:** K = warmth × water × soil × slope.
  - Warmth comes from the cell's warmest-month mean temperature (lapse rate plus sunny or shady aspect).
    This is what makes the **treeline**.
  - Water is W, how full the root zone is during the growing season. The column kernel integrates it day
    by day, so it includes rain, snowmelt, groundwater flowing into hollows, droughts and the plants' own
    water use.
- **Growth** is logistic toward K, at about 0.3 per year in warm places and slower near the treeline.
- **Dieback** above K (from drought or cooling) runs at 0.35 per year.
- Growth and dieback both use exact closed-form solutions for a batch of any length. So 16-year frames
  are as stable and as accurate as 1-minute frames.
- **Burial and stripping:** once per simulated year, cover is multiplied by
  exp(−(net deposition / 0.3 m + net erosion / 0.6 m)). This uses the *net* change over the year.
  Counting every up-and-down wiggle per batch made the loss depend on the batch length.
- **Feedbacks:**
  - Erodibility × (1 − 0.65 V)(1 + 4 burn).
  - Under full cover, creep is 60 % slower and talus failure 30 % slower.
  - Infiltration × (0.6 + 0.8 V)(1 − 0.7 burn).
  - ET factor is 0.45 (bare soil) + 0.75 V. The V term is transpiration from the groundwater store,
    logged as evap.
  - Frost weathering × (1 − 0.6 V).
  - Chemical and biological soil production × (1 + 2 V).
- **Groundwater capacity follows soil depth:** `gwCap = gwMax · min(1, 0.15 + 1.1(1 − e^(−soil/0.5 m)))`.
  Where erosion thins the soil, the excess water comes out as a spring, so the books stay exact.
- **Start-up:** on load, a 400-year spin-up runs only the column, groundwater and plants. Weathering,
  routing and erosion are off, so the terrain does not change. The spin-up ends on 1 January, then the
  clock and the water books are reset, so plants start in equilibrium with the climate.

### Weather brushes (what each one means)
- **Storm:** a 3-day cloudburst over the circle, at max(40 mm/day, 15 × the place's mean) × intensity.
  It falls as rain or snow depending on each cell's temperature, and goes through the normal snow, soil
  and runoff path.
- **Drought (map-wide, by choice):** real droughts are far bigger than the 5–10 km map.
  - It lasts 5 years. Rain and snow drop to 30 % and evaporation demand rises 25 %.
  - There is one drought at a time; a new click restarts it.
- **Flood (a "100-year flood"):** 150 m³/s × intensity pours into the clicked spot for 12 hours
  (3.2 million m³), like a flood wave arriving from upstream. It is added exactly like runoff.
- **Wildfire:** instantaneous, so it is the same at every speed.
  - It burns the circle, with severity set by the fuel.
  - It then spreads for 48 steps as site percolation. The chance of spreading rises with fuel, dryness
    (low W) and uphill slope. It races through dry forest and stops at wet valleys, bare rock and sparse
    desert.
  - Burned ground erodes up to 5× faster and soaks up to 70 % less water.
  - Burn severity fades over a few years (3-year e-folding time).
- **Using the tools:**
  - Pick a tool and click the land.
  - Hold and drag to steer a Storm or Flood. Drag with Wildfire to light a line of fire.
  - Right-drag still pans. Esc or "Look around" gives orbiting back to the left button.
  - The brush-size slider sets the radius.
  - Running events show as dashed rings and are listed in the date card.

### Speed independence of events
The scheduler splits every batch at the moment an event starts or ends (`Simulation._advance`). Within
a batch, each event is either fully on or fully off. For example, a 3-day storm brushed at 1000 yr/s
becomes one 3-day batch at full storm intensity, then the rest of the frame. The frame's hydraulic
sub-steps are shared between the pieces, so the GPU cost does not change. Event water is logged as
precipitation input (`cumPrecip` includes storm rain and flood water), so the balance stays exact.

### Picking
- The ray is built from the same float32 inverse view-projection matrix the frame was drawn with.
- It is intersected on the GPU with the same triangles the terrain shader draws: heights of
  bedrock + soil + snow/0.33, times the exaggeration, with the same alternating diagonal.
- This takes one workgroup and a 16-byte async readback, with at most one pick in flight.
- It hits the ground surface, not the water surface. Under deep lakes seen at a grazing angle, the picked
  point lies slightly beyond the water surface you see.

### Test hook additions
- `sim.brush(type, {x, y, radius, intensity, days, spread})`: x, y and radius are in grid cells. Returns
  the event.
- `sim.setTool(name)`, `sim.setOverlay('plants')`.
- `sim.pick(clientX, clientY)`, `sim.pickNDC(x, y)`, and `sim.pickReference(x, y)` (the float64 CPU
  reference).
- `sim.engine.setLandscapeChange(false)`: a test hook that freezes the terrain.
- `stats()` adds `meanVeg`, `vegCoveredFrac` (cover > 0.3), `burnedFrac` (burn > 0.1) and `events`.
- `window.__errors` and `window.__gpuErrors` collect console and WebGPU errors.

### Results (`tests/out-round2.json`, RTX 4060 Ti)
All 15 checks pass when the GPU is not shared.

- **Water balance with plants:** cone 512² Colorado, 1000 years: −3.3e-5 %.
- **Water balance with each brush,** at 1-minute and 1-year batches: worst case 0.0036 %. That is a short
  12-day run with tiny batches, where f32 round-off of small increments dominates. All other runs are
  2e-4 % or better.
- **No NaN** at 1 day/s or at 1000 yr/s (4,000 years in 4 s with all four brushes running).
- **Storm and flood volumes don't depend on speed:** batches of 1 min, 12 h, 5 d, 1 yr and 16.7 yr all
  deliver 24,767 m³ of storm water (expected 24,767) and 6,480,000 m³ of flood water (expected
  6,480,000). The largest deviation is 1e-5.
- **Same scenario at different batch lengths** (fire + storm + 2-year drought, 20 years; batches of 30 d,
  1 yr and 6083 d): spread of 0.4 % in mean cover, 1.5 % in groundwater, 0.7 % in outflow fraction and
  2 % in ET fraction.
- **Climate change** (+3 °C, 150 years; batches of 10, 365 and 6083 d): mean cover 0.499, 0.535, 0.537.
- **Burned vs identical unburned flank** (5 years, same storms): erosion 0.26 mm vs 0.03 mm (7.5×).
- **Recovery after fire** (cover in the burned patch):

  | When | Cover |
  |---|---|
  | Before the fire | 0.86 |
  | Right after | 0.09 |
  | 5 years later | 0.24 |
  | 60 years later | 0.86 (unburned twin: 0.85) |

- **Mean cover by place:**

  | Place | Mean cover |
  |---|---|
  | Utah | 0.19 |
  | Colorado | 0.45 |
  | Pacific NW | 0.56 |
  | Temperate | 0.55 |

- **Treeline (Colorado):**

  | Elevation | Cover |
  |---|---|
  | 2800 m | 0.91 |
  | 3200 m | 0.52 |
  | 3600 m | 0.16 |
  | 3800 m | 0.05 |

- **Drought (5 years):** cover drops from 0.233 to 0.198 and groundwater from 0.35 to 0.11 million m³.
  Sixty years later cover is 0.270.
- **Picking** (exaggeration 3, an 18° view of rugged terrain):
  - GPU vs float64 reference over 40 pixels: largest difference 0.0000 cells.
  - Vertex round trip: visible vertices come back within 0.009 cells; hidden ones hit nearer terrain
    (0 wrong).
  - A synthetic click with the Storm tool placed the storm 0.001 cells from the target cell.
- **Robustness:** loads of 512 → 256 → 1024 → 512 while playing with all four events running, plus a load
  during `sim.run()`: 0 GPU errors and 0 console errors. This test found and fixed a validation error in
  split batches.
- **1024² at 1000 yr/s with plants on:** 59.9 fps with 14 hydraulic sub-steps per frame (round 1: 18).
  GPU time is 8.8 ms for the simulation plus 2.0 ms for rendering. The fixed per-frame cost rose about
  1.4 ms (column loop and plant kernel).
- `node scripts/launch.cjs --selftest` still passes: cone 1000 yr, −3.3e-5 %, no NaN, 5.6 s.
- **Screenshots:** `tests/shot-plants-{colorado,pnw,utah,overlay}.png`, `tests/shot-fire-scar.png` and
  `tests/shot-storm-brush.png`. The scripts are in `tests/shots/`.

### Known limitations (round 2)
- **Daily weather vs mean weather:** round 1 uses daily wet/dry storm weather for frames of 2 days or
  less, and mean weather above that.
  - Storm weather sends more water off as runoff.
  - At 1-day batches, groundwater ends about 40 % lower and plant cover about 20 % lower than at batches
    of 30 days or more. At 3-day batches both are about 10 % lower.
  - So at the slowest speeds, plants slowly settle a little sparser than the fast-speed equilibrium.
  - Batches of 30 days and longer agree within 2 %.
  - The proper fix is a storm-intermittency closure in the column kernel for mean-weather batches.
- **Round-1 talus relaxation is counted per batch,** so long-run terrain change at the same sim time
  differs between batch lengths. The consistency tests freeze the terrain to keep this separate from
  plants, water and events.
- **Post-fire erosion is small** with the default erosion constants: it is real, but only millimetres per
  storm. The "Erosion strength" slider scales it.
- **Shared GPU:** frame rate and benchmark numbers drop when another program uses the same card. This
  happened during this round, when other agents' test windows shared the GPU. Re-run `fps_1024` and the
  self-test bench on an idle GPU.

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
