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

## Round 2: plants, soil and painted weather ("The Ecologist")

The land now has a living cover. Plants grow where water, warmth and soil allow, thin out in
drought, burn, get buried by mud or stripped by floods, and come back by succession: grass first,
trees over decades. They feed back on the water and the land. You can also paint weather onto the
map: a cloudburst, a drought, a 100-year flood or a wildfire, right where you click.

### What you see
- **Natural view:** grasses take the place's tint and turn straw-coloured when dormant or dry. Trees
  and shrubs are drawn as clumps whose area matches the simulated woody cover. Fresh burns are
  black char and grey ash, fading as they heal.
- **Plants overlay** (in "Show me"): bare, sparse, grass & shrubs, forest. Trees shift to a
  blue-green. Orange to dark red marks ground burned in the last few years.
- **Paint the weather** (panel): Look around, Storm, Drought, 100-year flood, Wildfire, plus circle
  size and strength sliders. With a tool picked, a coloured ring follows the mouse on the 3D ground.
  Click or drag to apply. Right-drag still slides the view, and Esc returns to Look around.
  "Slow the clock down to watch it happen" (on by default) drops to 1 day/s for storms and floods
  and to 1 yr/s for droughts and fires.
- The panel's running account adds ground covered by plants, average cover and recently burned area.
- `tests/shot-*.png`: plants in the Utah, Colorado and Pacific NW presets, the plants overlay, a fresh
  fire scar, the same scar a year later in natural view and overlay, and a storm brush with its ring.

### The vegetation model (`src/sim/vegetation.js`)
State per cell: total cover `veg` (0..1, the contract layer) = woody cover T + grass/herb cover G.
`eco` (vec4) holds T, burn severity, greenness, and a 1-year-lagged ground height used for burial.
`rip` holds riparian water access.

**Site climate, measured rather than assumed.** The column kernel already integrates every day of
the year per cell. It now also sums, over the growing season (snow-free days with a daily mean above
0.9 °C, the Körner & Paulsen 2004 definition), PET × root-zone moisture, PET, days and temperature.
Plants respond to the last complete calendar year. Calendar years, rather than a running mean, keep
the indices free of seasonal bias at every speed. From these sums:
- water index `Wi = Σ PET·moisture / Σ PET`, in the spirit of AET/PET (Stephenson 1990);
- growing-season length and mean temperature `Tgs`.

Because these come out of the real water and snow physics, the familiar patterns emerge rather than
being painted on:
- North faces get less sun, so they have less evaporative demand and later snowmelt. In the desert
  they are greener, with juniper on north slopes. Near treeline their colder, shorter season pulls
  the trees lower.
- Hollows fed by lateral groundwater stay moist.
- Desert lowlands are dry, and wetter, cooler heights carry piñon-juniper woodland. That is the
  lower treeline of dry country.

**Carrying capacity** (smooth ramps):

| limit | trees and shrubs | grasses and herbs | basis |
|---|---|---|---|
| warmth | Tgs 4.8 → 7.6 °C, season 60 → 100 days | Tgs 1 → 4 °C, season 20 → 55 days | global treeline at Tgs ≈ 6.4 °C and ≥ 94 days (Körner & Paulsen 2004); alpine-nival limit |
| water | Wi 0.18 → 0.60 | Wi 0.05 → 0.70 | trees need a moister root zone; dryland cover scales with water supply |
| soil depth | 35 % on bare rock → 100 % at 0.6 m | 45 % → 100 % at 0.12 m | rooting depth; trees root into fractured rock |
| channels | none where flow is deeper than 0.1–0.5 m | same | scour and drowning keep beds bare |
| riparian | streams or springs within 20 m count as Wi ≥ 0.8 | same | phreatophytes (willow, cottonwood, alder) tap the water table |

**Dynamics** are exact for any step length, so they behave the same at 1 day/s and 1000 yr/s:
- Growth is logistic with seed rain, solved analytically.
  - Grasses: r = 1.2/yr, plus a seed bank and resprouting. They recover in 2–5 years.
  - Trees: r = 0.03–0.15/yr depending on warmth and water, with seed from woody neighbours within
    about 40 m, so burns refill from their edges. Canopy closure takes about 30 years in the wet
    Pacific NW and 60–150 years in dry or subalpine forest (Turner et al. 1997; Agee 1993).
- Above capacity, cover dies back exponentially. Trees die at 0.25/yr, matching the piñon die-off of
  2002–03 (40–80 % in two years, Breshears et al. 2005). Grasses die back at 1.5/yr.
- Burial and stripping kill at a rate set by the sediment added or soil removed over about the last
  year: grass under 5–40 cm, trees under 0.3–1.5 m. Slow deposition is grown through.
- Burn severity decays with τ = 1.5 yr, the life of post-fire water repellency (DeBano 2000).

**Feedbacks:**

| on | effect | basis |
|---|---|---|
| infiltration | × (0.5 + 1.5·cover) × (1 − 0.5·burn) | 2–4× under shrub canopies (Bhark & Small 2003); burned soils repel water (DeBano 2000, Robichaud 2000) |
| ET | × (0.35 + 0.85·cover), drawn from the groundwater store and logged as evaporation | bare soil evaporates only from its surface; canopy crop coefficient ≈ 1.2 (FAO-56) |
| soil detachment | × exp(−3·cover); deep channel flow overrides it | E/E0 = exp(−b·C%), b ≈ 0.03–0.05 (Gyssels et al. 2005) |
| burned ground | rills form in thin flow, sediment capacity × (1 + 4·burn), pickup × (1 + 1.5·burn) | post-fire debris flows bulk with ash and loose soil (Cannon et al. 2001; Moody et al. 2013) |
| deposition | settling × (1 + 1.5·cover) | grass filter strips trap sediment |
| creep, talus | creep × (1 − 0.5·cover); slumping × (1 − 0.8·cover); repose angle + root cohesion | root cohesion 2–15 kPa (Schmidt et al. 2001) |
| weathering | frost cycles × (1 − 0.5·cover); chemical × (1 + 2·cover) | litter insulates; biotic weathering. Forest soil production ≈ 0.05–0.1 mm/yr (Heimsath et al. 1997) |
| groundwater | store capacity = gwMax × (0.2 + 0.8·(1 − e^(−soil/0.5 m))) | thin rocky soils hold little; fractured rock still holds some (Rempe & Dietrich 2018) |

Groundwater that no longer fits, for example when erosion strips the soil, seeps out as springs, so
the water balance stays exact.

**At load** the plants are spun up to equilibrium with the climate. The column kernel runs a
diagnostic two-year integration that writes only the climate indices and moves no water. This
alternates six times with a relaxation toward capacity, because transpiration and the water index
depend on each other.

### Weather brushes (`src/sim/events.js`)
Events are written into a per-cell GPU field (`evt`) and play out on simulation time:
- **Storm:** 60 mm/day for 3 days over the circle, with a soft edge. It falls as rain or snow by
  temperature. Each frame takes min(water left, rate × frame length), so a 3-day storm brushed at
  1000 yr/s still delivers exactly 3 days of storm water, as one pulse inside a 16-year frame. For
  scale, the Sept 2013 Colorado Front Range storm dropped about 450 mm in 5 days.
- **Drought (regional):** inside the circle, precipitation is cut to 40 % and the air is 1.5 °C
  hotter (a "hot drought", Williams et al. 2013) for 5 years. Each frame averages it exactly.
  Grasses brown within a season, the ground and springs dry, and trees die over 1–2 years.
  Real droughts are larger than the 5 km map; use the biggest circle (up to 3 km across) to cover
  most of it.
- **100-year flood:** a 100-year rainstorm of 100 mm/day for 2 days falls on the whole upstream
  catchment of the clicked spot. That is about the 100-year 2-day rainfall of the Colorado
  foothills (NOAA Atlas 14). The click snaps to the biggest stream inside the circle. The catchment
  comes from D8 steepest-descent routing on a CPU copy of the ground.
- **Wildfire:** ignites the circle, then spreads cell by cell into neighbours with fuel. The chance
  of spreading rises with cover and with dryness of the root zone, so fire stops at bare rock, snow,
  streams and wet riparian ground. Spread is limited to 2.5 radii. Severity rises with woody fuel:
  crown fire in forest, a lighter burn in grass. Fuel under snow does not burn, and the panel says
  so.

All event water enters through the column kernel's precipitation, so it appears in `cumPrecip` and
the balance stays exact.

**Picking** (`src/ui/brush.js`): the mouse ray is built from the exact view-projection matrix of
the last rendered frame, lens shift included. It is marched against a CPU copy of the displayed
surface (bedrock + soil + snow, refreshed every 3 s while a tool is picked) and refined by bisection.

**Test hook:**
- `sim.brush(type, { x, y, radius, intensity, days })`, with x, y and radius in grid cells. It
  returns info such as burned cells and catchment area.
- `sim.pick(clientX, clientY)` and `sim.setTool(name)`.
- `stats()` adds `meanVeg`, `vegCoveredFrac` (cells with ≥ 25 % cover) and `burnedFrac` (cells
  with burn severity > 0.1).

### Round-2 test results (RTX 4060 Ti, Electron 45)
Run `node tests/run-eco.cjs tests/r2-tests.js`, `tests/r2-ecology.js` and `tests/r2-fire.js`.
Screenshots come from `node tests/r2-shots.cjs`. Every check passes (`allPass: true`). The results
are in `tests/out-r2-*.json`.

| check | result |
|---|---|
| water balance, no brush and each of the 4 brushes, at 1 day/s and at 1000 yr/s (10 runs) | worst 2.2e-6 % |
| NaN | none in any run |
| 3-day storm water delivered ÷ painted, at 1 day/s, 1 yr/s, 1000 yr/s | 1.0000, 1.0000, 1.0001 |
| brush placement: API storm centroid; real mouse click (synthetic pointer event) | 0.00 and 0.01 cells off |
| picking round trip, 21 screen points | worst 0.01 px |
| cone, identical flanks, 2 years after fire plus the same storm on both | burned patch eroded 17× more |
| forested catchment (64 ha burned), 3 years at about 1 yr/s, before vs after fire | mean lowering 37 → 69 mm, max 1.8 → 3.1 m |
| recovery after a crown fire (Colorado, 1.3 m soil) | cover 0.99 → 0.02 → 0.79 after 5 yr (grass), 0.99 after 120 yr; woody 0.81 → 0.01 → 0.13 after 20 yr → 0.82 after 120 yr |
| mean cover after 300 yr: Utah / Colorado / Pacific NW / Temperate | 0.30 / 0.91 / 0.92 / 0.90 (woody 0.16 / 0.48 / 0.74 / 0.74) |
| treeline (Colorado) | woody 0.86 at 2960 m → 0.06 at 3600 m → 0 above 3800 m; Tgs at the treeline band 5.3 °C. Real Colorado treeline is ~3500–3600 m. |
| aspect, Utah | cover on north faces 0.41 vs south 0.20; woody 0.26 vs 0.06 |
| riparian, Utah | cover beside streams is 0.76 higher than uplands at the same elevation |
| soil under forest vs bare ground (Colorado / PNW / Temperate) | 1.9 vs 1.1 m, 2.6 vs 1.7 m, 2.5 vs 1.6 m |
| 5-year drought vs the same run without it (Colorado) | groundwater in the 3rd summer 0.049 vs 0.099 m; cover at year 5 0.53 vs 0.63; difference ≤ 0.005 at year 65 |
| "Rain & snow" slider to 0.25× at 1000 yr/s | cover 0.91 → 0.56 within 0.1 s of wall time (95 % of the change in 1 s); back to 0.87 within 0.5 s of returning it |
| `--selftest` (cone, 1000 years) | balance −3.2e-5 %, no NaN, 13.7 s wall (round 1: 5 s; see the timing note below) |
| bench, hydraulic sub-steps/s at 256² / 512² / 1024² | 27.4k / 9.2k / 1.7k (round 1: 59.6k / 11.7k / 2.2k); 60 fps at every size |
| live app, 512², 1000 yr/s with the plants overlay, then all 4 brushes and 1 day/s (`tests/r2-interactive.js`) | 60 fps, sim 8.2 ms + render 2.6 ms GPU per frame, no GPU errors, balance −1.8e-7 % |

### Changes to round-1 code a merger should know about
- `light` is now **8 floats per cell** (two vec4). The terrain and water shaders index `light[2i]`
  and `light[2i+1]`, which keeps the terrain vertex shader at 8 storage buffers. The column kernel
  binds 12 storage buffers and the vegetation kernel 12. This needs
  `maxStorageBuffersPerShaderStage` ≥ 12; `main.js` already requests the adapter's limit, and the
  RTX 4060 Ti reports 16.
- `soilStep()` (water.js) has a new signature with capacity, infiltration and ET multipliers, and
  `weathering()` takes the cover. The column kernel writes `clim` (3 vec4 per cell) and consumes
  `evt`.
- **Groundwater capacity depends on soil depth** (`gwCap()` in common.js, used by the column,
  groundwater springs and lighting). Initial groundwater is 30 % of that capacity.
- **Talus is now a rate, not a fixed fraction per batch.** It relaxes with an e-folding time of
  about 10 years, using 2 passes on long batches. Round 1 relaxed 0.25 of the excess every batch,
  so slow speeds (thousands of batches a year) stripped steep slopes that fast speeds kept. Slowing
  the clock then buried the plants below under sudden slumps (a 0.5 m mean slump and −35 % cover
  in 3 years). Creep and rock fall are unchanged per year.
- `electron/main.cjs`: scripted runs (`--selftest`, `--eval`) skip the single-instance lock and use
  their own temp profile. A test can then run while the app, or another worktree's test, is open.
  Previously such a run silently quit.
- `main.js` records the first WebGPU error messages in `window.__gpuErrorMsgs` for tests.

### Known weaknesses (round 2)
- **Hillslope wash is weak at real-time hydrology** (round-1 calibration). On an isolated burned
  slope, the post-fire debris pulse is about 0.5 mm in two years: 17× the unburned slope, but too
  small to see. It shows up at ~1 yr/s and faster, where the morphological factor applies, and in
  channels draining a burn.
- **Cover depends a little on speed:** after slowing from 1000 yr/s to ~1 yr/s, Colorado mean cover
  dips from about 0.88 to 0.71 and then settles. Steep thin soils are redistributed faster at slow
  speed (the remaining round-1 erosion/talus time dependence), and the soil factor follows. The
  drought test compares two runs at the same speeds, so it is unaffected.
- Closed hollows fill into lakes at slow speed (a round-1 property) and drown the forest in them.
- One plant community per cell (woody vs herbaceous). There are no species, no shade-tolerance
  succession, and no natural lightning fire regime. Fire spread ignores wind and slope.
- Greenness, which drives the browning colour, uses the instantaneous root-zone moisture. At high
  speed it shows the strobe-sampled season, not an average.
- Speed: the column kernel (more state, growing-season sums) and the vegetation kernel add per-batch
  cost, so `sim.run()` (thousands of short batches) is slower than in round 1. Interactive frame rates
  are unchanged at 60 fps. The timings were taken while other agents' test windows shared the GPU
  (17–100 % busy), so they are upper bounds.

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
src/sim/vegetation.js  plant cover (woody + grass), succession, burial, burn decay (round 2)
src/sim/events.js      weather brushes: storm, drought, 100-year flood, wildfire (round 2)
src/sim/stats.js       GPU reductions, flux log ring, async readback
src/render/            raw WebGPU renderer from the Artist build (shaders.js, lighting.js for shadows/AO) + orbit camera
src/ui/panel.js        side panel, date card, time bar (layout from the Artist build); legend.js
src/ui/brush.js        event brush tool: terrain ray picking, cursor ring, click/drag (round 2)
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
- Groundwater flows only through a shallow store whose capacity depends on soil depth (round 2); there is no deep aquifer.
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
