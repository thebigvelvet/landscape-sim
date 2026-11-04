# Landscape Time-Lapse

A 3D landscape you can rain on, freeze, thaw and erode, from 1 day per second up to 1000 years per
second. All of the simulation runs on the graphics card (WebGPU compute shaders).

**To run it, double-click `start.bat`** (or the "Landscape Time-Lapse" shortcut on the desktop).

## Round 9: geologic provinces and what lies underground

Built directly, on branch `r9-provinces` (cut from `main`).

**What you can do now**
- A **Geology** dropdown (Landscape section) picks the kind of country the rock comes from. Random picks one from the seed. Every province has its own rocks, structure and anomalies:
  - **Colorado Plateau** (updated): flat-lying cross-bedded dune sandstone, ledgy and river sandstones, purple-green bentonitic mudstone, marine gray shale, limestone and gypsum near the base. Thick dune sandstones sit on soft mudstone, so cliffs stand over slopes. Structure: gentle dip, monoclines, broad folds, basement-cored uplifts and Moab-style normal faults. Anomalies: laccoliths, salt anticlines, breccia pipes, joint sets and the odd volcanic neck with radiating dikes.
  - **Southern Rockies**: a crystalline core of pink granite, banded gneiss and dark schist. A thin cover of sediments survives on one flank, turned up on edge into hogbacks by a steep monocline. Anomalies: dikes, crushed fault zones, a hydrothermally altered (ochre) zone, and a hot spring on a fault.
  - **Valley and Ridge**: tight, plunging folds of quartzite, sandstone, limestone, dolomite, shale and coal, cut by thrust faults. Anomalies: karst with sinkhole seeds, losing streams and cave springs, and sometimes a warm spring on a thrust.
  - **Gulf Coastal Plain**: a low plain (terrain relief × 0.3) of soft sand, clay, marl and chalk dipping gently to the sea, stepped by growth faults. Anomalies: salt domes ringed by upturned beds, with caprock over salt.
- The landscape description under the dropdown lists each anomaly with what it does and its **geophysical signature** (magnetic, gravity, heat flow, seismic, radiometric).
- **Home climates:** picking a province switches the climate to its home one (Plateau: Utah desert, Rockies: Colorado alpine, Valley and Ridge: Temperate, Gulf: the new **Gulf Coast humid**), with a notice saying so. It happens only when the province changes, so a climate you pick yourself stands when you remake the same province. Random follows the province the seed picks. `sim.load()` itself never changes the climate.
- **Gulf Coast humid** climate (like Baton Rouge or Houston): about 20 °C mean, 1.5 m of rain a year peaking in summer, mild winters with hardly any frost, high evaporation, near sea level, pine-oak forest, an onshore breeze. On the Gulf plain over 30 years (`tests/province-climates.js`, 7/7): no January snow or frost (Temperate: 9 mm and 0.13 m), 82 % plant cover, 64 % more rain than Temperate, water books closed.
- A new **Subsurface** view: soluble rock (cyan), salt (white), groundwater conduits (blue), hard intrusions (black) and hot ground (red).

**How it works** (`src/sim/strata.js`, plus small additions to the column and groundwater kernels)
- Every rock now has two more properties: how fast groundwater dissolves it (limestone 1, gypsum 5, salt 30) and how easily groundwater moves through it.
- The structure gains fault steps, domes (round or long), a fold plunge and joint sets. All of it is analytic, like the beds, so it needs no new buffer and survives erosion and sculpting exactly.
- Anomalies are a table of up to 12 shapes (a line segment or a point, with a half-width). Buried bodies (salt, laccolith cores) start at a set depth in the stack.
- **Effects on the land:**
  - Hardness: dikes, necks and laccolith cores resist erosion; fault zones, altered rock and breccia pipes wear fast; jointed sandstone wears faster along the joints.
  - Groundwater moves up to 20× faster along faults and 10× through pipes and hot-spring conduits, so springs come out where they cross the valleys.
  - Streams lose water fast where they cross bare soluble rock (and fault zones).
  - Groundwater dissolves soluble rock at the surface and up to 60 m below it, so the ground settles into sinkholes, over salt domes and along salt-anticline crests. The dissolved rock leaves the map in solution and is counted with the sediment out, so the solids books stay closed.
  - Hot springs warm the ground by 8-30 °C at the vent, fading over three vent radii: no snow or frost there.

**Checks** (RTX 4060 Ti)
- `tests/provinces.js` passes 22/22:
  - Generator, 200 seeds per province: plateau beds stay irregular (median thickness CV 0.82), dips 0.3-3.9°, basement never shows at the start, and 85 % of dune sandstones sit on soft rock. Anomaly rates match the design (laccolith 24 %, salt anticline 25 %, breccia pipes 44 %, joints 57 %, uplift 20 %, neck 15 %). Rockies: 92 % of cells start in the crystalline core, and every map has dikes and faults (hot spring 65 %). Valley and Ridge: 3.3 fold crests across the map on average, 18 beds exposed, thrusts on every map, sinkholes on 95 %. Gulf: dips 0.05-0.49°, a salt dome and a growth fault on every map.
  - Rockies, 20,000 years: dikes lowered 1.2 m vs 3.1 m beside them; fault zones 13.3 m vs 4.1 m; spring flow on the fault zones 4.6× the ground beside them. At the hot spring in late January: 3 mm of snow water and no frost, against 0.30 m and 1.1 m of frost around it.
  - Valley and Ridge, 20,000 years, twin runs with sinkholes off: rock under the sinkholes dissolved 52.6 m vs 1.8 m, leaving closed hollows in the rock floor (4 vs 1). Under a painted 3-day storm on bare limestone, karst cut the storm runoff leaving the map by 38 % against an insoluble twin.
  - Gulf: relief 326 m against 1,085 m for the same seed as Plateau; the ground over the salt domes sank 2.1 m while the ground around them gained 0.2 m.
  - Plateau: the rock along a salt anticline's crest went down 82.5 m vs 29.6 m on its flanks (the collapsed valley fills with sediment); jointed sandstone wore 1.21× as fast as unjointed; an exposed laccolith core (19 cells, a small exposure) lowered 3.9 m vs 13.6 m on its flanks (40,000 years at 3× erosion).
  - Water balance within 4e-7 % in every run. Solids balance within the same float rounding as with layers off (about 1e-7 of the rock volume).
- Regression: `strata` 7/7, `round2` 10/10, `round3` 7/7, `deposits` 5/5, `glacier` 11/11. Two tests miss their thresholds because the plateau rock changed, not because of a fault in their code:
  - `wind` 11/12: `directionDial` along-wind share is 0.49 against 0.5. It passed only narrowly before (0.504).
  - `volcano` 16/17: `basaltIsHard`: basalt now wears 0.74× as fast as the plateau rock around it (needs < 0.7×), because the new plateau has thick, hard dune sandstones.
- Frame rate (`tests/perf-provinces.js`, 512): 60 fps in every province at 1 day/s and 1000 yr/s. Rendering costs up to about 1 ms more per frame (Gulf, 4.9 ms against 3.8 ms with layers off).
- Pictures: `tests/shot-r9-{plateau,rockies,valleyRidge,gulf}.png` after 15,000 years, and `tests/shot-r9-{rockies,valleyRidge}-subsurface.png` in the Subsurface view.

## Round 7: glaciers

Built directly, on branch `r7-glaciers` (cut from `r6-wind`).

**What you can do now**
- Glaciers form on their own wherever snow outlasts the summer year after year. There is no special preset: turn the **Temperature** slider down to grow them, then warm it up to watch them melt back.
  - On Colorado alpine at today's temperature there is no lasting ice (at most a few tiny patches).
  - At −4 °C there are a few small cirque glaciers; at −6 °C cirque and short valley glaciers (4 % of the map); at −8 °C valley glaciers that reach the valley floors (17 %).
- A **Glaciers** checkbox in the climate section turns them on or off.
- A new **Glaciers** view shows the ice coloured by how fast it flows, pale where it is thin, with brown where it carries a lot of rock.
- In the natural view, bare glacier ice is blue-white and glossy, and crevassed where it is fast and steep. It turns grey near the snout, where the rock it carries comes to the surface. Fresh snow lies on top.

**How it works** (`src/sim/glacier.js`, plus the column kernel)
- **Ice from snow:** snow beyond 1.5 m of water equivalent compacts into ice over about 3 years.
- **Melt:** bare ice melts at 8 mm/°C/day (snow: 4.5), faster on sunny slopes. A debris cover near the snout slows it.
- **Flow** (the same exactly conservative pair-transfer form as the avalanches):
  - Ice moves by the smaller of two rates: the physical rate (Glen's flow law, deformation plus sliding), and the amount that brings its surface down to the slope a 60 kPa yield stress can hold. The physical rate gives real creep speeds at slow time scales. The yield-stress profile gives glaciers their shape at the fast speeds.
  - No glacier surface stands steeper than 24°: steeper ice breaks off at once (icefalls), so cliffs stay bare and ice gathers in the cirques below.
  - Ice can flow off the map edge; it is logged as outflow, and its rock as sediment out.
- **Carving:**
  - Moving ice bulldozes the soil under it, then grinds the bedrock at 1e-4 × the sliding speed (capped at 150 m/yr). Soft beds go faster, and soil shields the rock.
  - Ice carries at most 8 % of its thickness in rock.
- **Moraines:** as ice melts, it lets go of its rock in proportion. That rock is laid down as soil, plus a coarse till sediment bed.
- Trees do not grow on the ice. Avalanches and drifting snow see the ice surface, and the wind cannot lift soil from under it.
- **Water books:** ice counts as 0.9 m of water per m, so the balance stays exact.
- **Limitation:** ice moves at most about one cell per flow step. There are about 24 steps per simulated year, capped at 48 per frame. So at the very fastest speed (1000 yr/s) glaciers run somewhat thicker and slower than real ones.

**Also fixed:** a race in the stats readback. A readback that began just before a new map loaded could add the old map's totals to the new map's books. This is very likely the intermittent balance errors seen after rounds 2 and 3. Each load now starts a new generation, and stale readbacks are dropped.

**Checks** (RTX 4060 Ti)
- `tests/glacier.js` passes 11/11 (twice in a row):
  - At −6 °C, ice covers 17 % of the top third of the map, 6 % of the middle third and 1 % of the bottom third, and 6.9× as much of north faces as south faces.
  - The ice moves (57 % of ice cells faster than 5 m/yr), and 69 % of it lies bare at the end of summer. That ice survives only because ice keeps flowing down to it.
  - At +4 °C there is no ice; at normal temperature there are no ice cells over 1 m.
  - Warming back to normal for 300 years melts 99.98 % of the ice.
  - After 3000 years at −8 °C, the bedrock under the ice is 5.5 m lower, against 3.3 m in a glaciers-off twin, and the ground around the ice has 12 % more soil.
  - Water balance is within 1e-6 %, with solids balanced; 30-day batches give the same glaciers.
- Regression: `round2` 10/10, `round3` 7/7, `strata` 7/7, `deposits` 5/5, `wind` 12/12. `--selftest`: balance 1e-6 %.
- Frame cost (`tests/perf-glacier.js`, 512, after 1000 years at −8 °C): 60 fps at 1 day/s and at 1000 yr/s, with 48 flow steps per frame.
  - With glaciers off at −8 °C the old behaviour returns: snow piles up hundreds of metres. Drawing those spikes drops the 1000 yr/s view to about 48 fps.
- Pictures (Colorado alpine, 512, seed 7, late August):
  - `tests/shot-glacier-ice.png` and `-overlay.png`: 1000 years at −8 °C;
  - `tests/shot-glacier-retreat.png` and `-carved.png`: the same, then 400 years back at normal temperature (bare valleys, and the change-since-start view).

## Round 6: wind

Built directly, on branch `r6-wind` (cut from `r5-sediment`).

**What you can do now**
- A new **Wind** panel section.
  - "Wind shapes the land" turns the wind on or off.
  - A compass dial sets where the wind blows from. The arrow shows where it blows to.
  - **Strength** sets how hard it blows. Sand starts moving at about 0.6.
  - **Steadiness** sets the dune type:
    - steady: ridges and crescents across the wind;
    - two winds 160° apart: long straight dunes along the mean wind;
    - wind from all around: star and dome dunes.
- Each climate brings its own wind:
  - Utah: a strong SW wind;
  - Colorado: strong westerlies;
  - Pacific NW: gentle;
  - Temperate: moderate and changeable.
- A new **Wind & sand** view shows wind speed, the sheltered lee (dark) and wind-blown sand (gold).
- Wildfires and their smoke now follow the prevailing wind.

**How it works** (`src/sim/wind.js`)
- Each step, every cell works out its local wind.
  - Wind speeds up on windward slopes and crests (up to 1.8x).
  - It drops to nothing in the wind shadow behind ground that rises more than ~15° upwind.
  - Plants slow it.
- **Sand** follows a Werner-style hop model.
  - Dry, bare, unfrozen, snow-free ground gives up sand as (u² − ut²)·u.
  - The sand hops downwind one cell at a time.
  - It settles readily on sand, in the lee and among plants, and hardly at all on bare rock.
  - Dunes grow out of that, and their lee faces slide at sand's 33° angle of repose (a new rule in the slope step of `erosion.js`).
  - Wind-laid sand is recorded as sand beds.
- **Dust** is the fine part of the soil.
  - It travels far and settles where plants or damp ground catch it, or leaves the map.
  - Winnowing leaves the coarse part behind as a gravel top bed. That desert pavement armours bare slopes after a few centimetres, so sand then comes mostly from washes and fans. The fines come out from under the stones, so the pavement only thickens; blown sand that lands on it is its own bed, so the pavement reappears when the sand moves on.
  - Ordinary soil is crusted: the wind gets sand out of it 50x more slowly than out of loose sand beds. Loose sand goes first, however thin; a dust film under 2 cm does not seal it.
- **Sandblasting**: sand passing over bare rock wears it down, soft beds about 5x faster than hard ones. The worn rock becomes sand.
- **Drifting snow** is moved off exposed ground into the lee and hollows when it is cold.
- **Conservation:** every parcel is split exactly the same way by the cells that receive it, so soil and snow are exactly conserved.
  - Sand and dust blown off the map are logged as sediment out.
  - Snow blown off the map is logged as water outflow.
- **Limitation:** each step lifts at most 8 cm per cell. At more than about a year per frame, dunes travel slower than real ones. On High detail maps (1024) the step count per frame is halved to hold 60 fps.

**Checks** (RTX 4060 Ti)
- `tests/wind.js` passes 12/12:
  - dunes grow about 30 m out of a flat 4 m sand sheet in 300 years and travel downwind 10 cells in 50 years;
  - lee faces are 31° and windward slopes 27° (90th percentiles);
  - under a steady wind the ground rises and falls more going downwind than across (crests across the wind, zigzag barchanoid ridges: 57 % of the slope energy runs along the wind; north wind 50 %), two winds build ridges along the wind (4 %), and a north wind turns the travel;
  - the wet, green Pacific NW and a gravel pavement barely change (less than 0.1 m of relief);
  - soft beds wear 0.18 m and hard beds 0.04 m in 200 years of sandblasting;
  - lee snow is 40 % deeper, and exposed ground keeps 25 % of its snow;
  - solids and water balance (1e-6 %).
- `tests/diag-sand.js` (Utah, 512, seed 7): blown sand after 10 / 50 / 150 years is 0.14 / 0.63 / 1.1 million m³ (it was 3.4 / 6.0 / 9.7 million before the pavement and crust fixes), and 30-day and 4-day time steps agree.
- Regression: `round2` 10/10, `strata` 7/7, `deposits` 5/5, `round3` 7/7. The `round3` avalanche comparison now runs with the wind off, because drifting snow also strips cliffs and would hide the avalanches' share. `--selftest`: balance 1e-6 % over 1000 years.
- Frame cost (`tests/perf-wind.js`, everything on, 1000 yr/s): 60 fps at 512 (+0.9 ms) and at 1024 (+2.8 ms).
- Pictures:
  - `tests/shot-wind-desert.png` and `-desert-off.png`: Utah after 500 years, with and without wind. Ground colour is the mix of the top 5 cm of beds, so a dusting of sand only tints what is under it;
  - `tests/shot-wind-overlay.png`: the same Utah run in the Wind & sand view;
  - `tests/shot-wind-sea-{steady,linear,star}.png`: a flat sand sheet after 400 years at the three steadiness settings;
  - `tests/shot-wind-snow.png` and `-snow-off.png`: Colorado alpine in March.

## Round 3: shaping the land, and avalanches

Built directly (no competing builds). Real Colorado/Utah terrain was dropped from this round.

**What you can do now**
- **Shape the land** (new panel section, keys Q W E R T): pick a tool, then hold and drag on the
  land. It works while time runs or while paused, and it uses the same size and strength sliders
  as the weather tools.
  - **Raise** and **Lower** push the ground up or dig it down.
  - **Smooth** softens peaks, cliffs and pits.
  - **Flatten** levels the ground to the height of the spot you first pressed.
  - **Channel** cuts a riverbed along the line you drag. The bed follows the ground as it was when
    the stroke began, so going over a spot twice does not dig deeper.
- **Undo** (button or Ctrl+Z) takes back the last stroke, up to 20 strokes. It removes only the
  shaping, so any erosion that happened since then is kept.
- **Avalanches**: snow slides off slopes where the snow surface is steeper than about 38° and
  piles up at the foot. Steep faces and ridges show bare rock in winter, with the snow gathered in
  the gullies. Where a lot of snow keeps running through, trees are knocked down.

**How it works** (`src/sim/sculpt.js`, `src/sim/snow.js`)
- Every shaping change also moves `initHeight`, the reference the erosion map, the solids books and
  the map-edge base level all measure from. Three things follow:
  - the erosion map shows only what nature did;
  - the solids still balance;
  - a dam raised on the edge of the map raises that edge's outlet too.
- Only shaping writes `initHeight`, so a stroke's change is exactly "after minus before", which is
  what undo puts back.
- Raised ground is new rock under the existing soil. Plants on it are buried, as by a landslide,
  and grow back.
- Avalanches use the same race-free, exactly conserving scheme as the talus slides: four passes
  per time step, after erosion. Snow is only moved, never made or lost, so the water books do not
  change.

**Checks** (RTX 4060 Ti)
- `node scripts/launch.cjs --eval=tests/round3.js` passes 7/7:
  - raise and lower are exact at the centre and change nothing outside the ring;
  - the erosion map does not show sculpting;
  - solids stay balanced through a year of weather;
  - undo restores the reference heights exactly and keeps the erosion;
  - flatten and smooth work;
  - a carved channel carries about 1,000 times more storm water than the ground beside it;
  - avalanches halve the snow on cliffs and add 26 % to the ground below them;
  - 150 strokes while running at 1000 yr/s cause no NaN and no GPU errors.
- `tests/ui-sculpt.js` drives the tools with real mouse events and the Undo button: 7/7.
- `tests/round2.js` passes 10/10. One run showed a 42 % water-balance error in the
  "storm at 1 day/s" case. It did not reappear in two reruns or in a direct probe of the same case,
  with avalanches on or off. It looks like the same intermittent fault as the 0.23 % reading noted
  below, and is worth hunting down on its own.
- `--selftest`: water balance 1e-6 % over 1000 years, 60 fps.
- Pictures:
  - `tests/shot-r3-dam.png`: a ridge raised across a valley, then a flood fills the lake behind it;
  - `tests/shot-r3-channel.png`: a spiral channel down a cone;
  - `tests/shot-r3-avalanche.png` and `-off.png`: Colorado alpine after 50 years, in March, with
    and without avalanches;
  - `tests/shot-r3-ui.png`: the panel.

## Round 2 (combined): what came from where

Round 2 had three competing builds (branches `r2-ecologist`, `r2-showman`, `r2-engineer`). This
version is the Showman build with these changes:

| Part | From | Notes |
|---|---|---|
| Visuals, 3D trees, storm clouds, fire/smoke, tool row, messages, slow-motion speeds, exact water books at slow speed | Showman | the base; its own notes follow below |
| Where plants can grow (`src/sim/vegetation.js`, carrying capacity) | Ecologist | growing season (days above 0.9 °C and their mean temperature) sets the treeline (Körner & Paulsen 2004); separate tree and grass ramps for warmth, water and soil depth; stream banks and springs count as well-watered (riparian corridors) |
| Bare rock stays bare | combined | grasses need soil (12 % of capacity on bare rock, full at 15 cm); sparse cover is drawn as flecks on rock, not a green tint |
| Debris flows on burn scars (`src/sim/erosion.js`, `debrisMul`) | combined | on fresh burns, flow gathered into rills and channels gets up to 21× the transport capacity (Cannon et al. 2001) |
| Robustness | checked, nothing to port | the Engineer's crash fixes were for its own scheduler; this base passes the same stress tests (loading new maps mid-event and during `sim.run`) with no errors |

Checks on this build (RTX 4060 Ti):
- **Test suite:** `node scripts/launch.cjs --eval=tests/round2.js` passes 10/10 (water balance with every brush at 1 day/s and 1000 yr/s, no NaN, burned ground erodes more, recovery after fire, desert vs wet, treeline, brush lands where clicked, storm speed scaling, flood surge, drought). Two of Showman's checks were updated for the combined build:
  - The treeline check now tests fixed elevations: trees below 3,000 m and none above 3,700 m.
  - Fire recovery is now compared with an unburned control run, not with the load-time spin-up.
- **Plant patterns:** the Colorado treeline is at about 3,450 m (the real one is ~3,500 m). Utah cover is 0.19 on north faces, 0.13 on south faces and 0.99 on stream banks.
- **Burned vs unburned twin slopes on a cone** (two cloudbursts, 2 years): 1.7 mm mean lowering with channels cut 17 cm, against 0 on the unburned slope.
- **Self-test and frame rate:** `--selftest` water balance is 1e-6 %, and 1024² runs at 60 fps at 1000 yr/s.
- **One unexplained reading:** one 100-year review run showed a 0.23 % water-balance error that did not reappear in five reruns of the same script. It is noted here in case it shows up again.
- The review probes are in `tools/review/r2/`.

## Round 2 (branch `r2-showman`): plants, soil and weather you paint on the map

**What you can do now**
- Plants grow by themselves: grass, shrubs and forest wherever there is warmth, water and soil.
  There is a treeline. Aspens turn gold in a Colorado autumn, and maples turn red in Temperate.
  Conifers carry snow in winter, and everything browns in a drought.
- **Weather events** (new panel section, keys 1-5, Esc to stop): pick a tool, then click or drag on
  the land. A dashed ring shows where it will land and how big it is, a ripple confirms the click,
  and a short message says what just happened. Some messages have a button that sets a good speed
  to watch, for example "Watch in slow motion".
  - **Storm:** a cloudburst with a dark cloud, a rain (or snow) curtain, lightning and a cloud
    shadow. Drag to steer it.
  - **Drought:** five dry, hot years. The sky turns dusty, grass goes gold then brown, mud cracks,
    lakes shrink and groundwater sinks.
  - **Flood:** a 100-year flood wave pours in at the click and runs down the valley.
  - **Wildfire:** a glowing fire front with smoke that runs uphill and downwind. It leaves a
    charred scar with dead snags, which sheds mud in the next storms and greens up over the years.
- New overlay **Plants & burn scars**, with a legend. "Show trees in 3D" can be switched off.
- The speed dial now goes down to **slow motion** (about 15 minutes to 1 hour per second), where
  water moves at its real speed and you can watch a flood wave travel.
- The "What's happening" panel shows how much ground is covered by plants and how much recently burned.

### Simulation design
New layers (`world.js`): `veg` (cover 0..1, f32), `burn` (burn severity 0..1, f32), `plant`
(vec4: woody share of the cover, moisture memory, ground height at the last batch, active fire) and
`fireNext` (scratch).

`src/sim/vegetation.js` exports `{ name, init, step, record(pass) }` and runs at the end of every
batch, after erosion. It has two kernels:
- **fire:** a race-free spread step. Fire needs fuel and dry ground, snow and standing water
  block it, and it runs faster uphill and downwind.
- **grow:** the cover relaxes toward an equilibrium V\* = warmth × water × soil × slope ×
  (no standing water) × (no glacier), using exact exponential integration over the batch, so the
  result does not depend on batch length:
  - Warmth: `smoothstep(3, 9.5, Tw)`, where Tw is the warmest-month mean temperature.
    Trees need `smoothstep(8.5, 11.5, Tw)`, which puts the treeline near the 10 °C July isotherm.
  - Water: the climate's aridity P/PET, which a drought lowers at once, plus a **moisture memory**.
    The memory is the groundwater fill smoothed over about 1 year. The column kernel integrates it
    at sub-day resolution, so it is the same at every speed.
  - Rates: growth 0.35/yr, die-back 0.8/yr, woody plants 0.045/yr up and 0.25/yr down.
  - Burial by fresh deposits and stripping by erosion act as a mortality rate built from the
    ground-height change since the last batch: (dz⁺/0.25 m + dz⁻/0.15 m)/t.
  - Burn scars fade with a 3-year e-folding time.
  - The kernel also writes `temp`, which moved here from the column so the column stays at 10 bindings.

At 1000 yr/s a frame is about 16 years, so cover sits at equilibrium and follows the climate
sliders within a few frames. At 1 day/s it changes over years, as it should.

**Feedbacks**

| Process | Effect of plants (cover v) | Effect of burn (b) |
|---|---|---|
| Infiltration (`water.js soilStep`) | × (0.7 + 1.0 v) | × (1 − 0.75 b): ash and water-repellent soil |
| Evapotranspiration | PET × (0.4 + 0.8 v), drawn from the groundwater store, logged as evap | |
| Erodibility (`erosion.js`) | pickup × mix(1, 0.12, v) | × (1 + 3 b) |
| Transport capacity | × mix(1, 0.35, v): vegetated sheet flow drops its load | × (1 + 8 b); the thin-flow limiter relaxes, so mm-deep sheetwash moves loose ash (post-fire rilling and debris flows) |
| Creep / talus | creep × (1 − 0.6 v̄), talus × (1 − 0.3 v̄); v̄ is the pair mean, so the gather stays exactly conservative | |
| Weathering (`freezethaw.js`) | frost shattering × (1 − 0.6 v); chemical and biotic soil production × (1 + 2.5 v) | |
| Groundwater capacity (`common.js gwCap`) | gwMax × (0.15 + 0.85 · min(soil, 2 m)): thin rocky soil holds little | |

**Start-up spin-up:** after a load, `_spinUp()` runs the column and lateral groundwater over a
few representative years with nothing routed (fR = 0), then sets the cover to equilibrium. A new
landscape therefore starts green where it should, with realistic groundwater and snow. Accounting
starts afterwards, so the books are unaffected.

**Exact water books at tiny batches (fix that also helps round-1 code):** at 1 day/s,
groundwater and snow change per batch by less than their own f32 rounding step. The summed fluxes
and the actual storage change used to drift apart by about 0.018 % of precipitation. Two fixes:
- The column now closes each cell exactly: outputs = P − ΔStorage, as the multi-year path already did.
- The column and groundwater kernels log their remaining f32 roundoff as outflow.

The 1 day/s balance error went from 0.0175 % to 0.00003 %.

### Events (`src/sim/events.js`), all in simulated time and averaged over each batch like `stormFactor`
| Event | Physical meaning | Water accounting |
|---|---|---|
| Storm | Local cloudburst with a cosine-bell profile over the circle: 80 mm/day at the centre × strength for 3 days. Rain or snow by temperature through the normal snow and soil model | Precipitation in the column (4 slots, uniforms only) |
| Drought | **Map-wide** (a real drought is far larger than this 5 km map) for 5 years: precipitation × 0.3, ET × 1.3, +1.5 °C | Reduced precipitation |
| Flood | **A 100-year flood arriving from upstream**: a triangular hydrograph peaking at 150 m³/s × strength over 12 hours (3.2 million m³), entering at the click over a disc of radius 6-14 cells. Water is added at every hydraulic sub-step (a sub-step hook) so the wave travels | Logged as precipitation. The share the routed solver cannot carry at high speed (1 − fR) is logged as precipitation and fast outflow in float64 on the CPU |
| Wildfire | Ignites the cover in the circle, applied immediately even while paused. Spread runs one step per batch ("visual time": a real fire runs its course within a day or two, a blink at any speed of the dial). The front lasts a few seconds; "fire weather" fades over about 10 s | No water |

A 3-day storm brushed at 1000 yr/s delivers the same water as at 1 day/s (test 8: 20,181 vs
20,178 m³; expected 20,178 m³).

### Rendering
- The terrain now draws the real `veg`, `woody`, `burn`, `fire` and moisture layers, replacing the
  old `vegAmt` heuristic:
  - Grass is green in the growing season, gold when dry, tan when dormant, and patchy when sparse.
  - The canopy colour per species is conifer, broadleaf (seasonal) or pinyon-juniper.
  - Burn scars show char and ash that fade to dark earth, with green shoots on top.
  - Drought shows paler soil with mud cracks.
  - Fire shows as an animated glow plus embers.
- To stay within the vertex shader's 8 storage buffers, `light` is now `vec4<u32>`, packed by
  `lighting.js` (see the header there): `pack2x16unorm(sun, ao)`, `pack2x16unorm(gw fill, spring
  code)`, `pack4x8unorm(veg, woody, burn, fire)`, `pack4x8unorm(moisture, ...)`.
  **Any shader that reads `light` must unpack it.**
- **3D trees:** a compaction compute pass (every lighting update) appends visible tree and snag
  cells to an instance list with an atomic counter that is also the `drawIndirect` argument.
  Frustum culling and a sub-pixel LOD apply. Each tree is a 36-vertex double cone shaped per
  species, with wind sway, snow on boughs, drought browning and fire glow.
- Other new passes:
  - **Smoke:** billboards over burning cells.
  - **Storm clouds:** a cloud deck plus rain or snow curtain per active storm, with lightning flashes.
  - **Ground markers:** event markers, the brush cursor and the click ripple are drawn on the
    ground in the terrain shader.
  - Event visuals last at least a few seconds of wall time, even when the simulated event is over
    in one frame at high speed.
- **Picking:** CPU ray march against a cached height field. The cache is a readback of bedrock +
  soil about once a second while a tool is selected. The ray uses the renderer's own inverse
  view-projection, including the panel lens shift. Clicks on the side of the block map to the edge cell.

### Test hook additions
- `sim.brush(type, {x, y, radius, intensity, days})`: does exactly what a click does, including
  the message.
- `sim.setTool(name)`, `sim.pick(clientX, clientY)`, `sim.screenOf(x, y)`, `sim.refreshHeights()`, `sim.brushTool`.
- `stats()` adds `meanVeg`, `vegCoveredFrac` (cover ≥ 0.3), `burnedFrac` (burn ≥ 0.1) and `meanWoodyCover`.
- `sim.load(..., { spinUp: false })` skips the spin-up.

### Round-2 results (RTX 4060 Ti, Electron 45). `tests/round2.js` → `tests/out-round2.json`: all 10 checks pass
| Check | Result |
|---|---|
| Water balance with plants and each brush, at 1 day/s batches and at 1000 yr/s | worst 0.00004 % |
| No NaN, live with rendering, fire + storm at 1 day/s, then flood + drought at 1000 yr/s (8,000 years) | no NaN, 0 GPU errors, 60 fps |
| Burned vs identical unburned patch (V-valley wall, two cloudbursts, one year) | burned 1.1 mm mean lowering (6 mm max cut); unburned 0 |
| Recovery after fire (Temperate) | cover 0.66 → 0.09 after the fire → 0.23 (1 yr) → 0.49 (5 yr) → 0.58 (60 yr); woody 0.56 → 0.06 → 0.46 (60 yr) |
| Mean cover after 20 years (random terrain) | Utah 0.15, Colorado 0.48, Pacific NW 0.52, Temperate 0.53 |
| Treeline (Colorado cone) | tree cover 0.96 at 2,910 m, 0.10 at 3,000-3,130 m, 0.01 above 3,340 m; tundra cover 0.45 up top |
| Brush lands where clicked (synthetic pointer events) | worst 0.008 cells; screen round trip 0.008 px; fire burn centroid within 0.02 cells |
| Storm speed scaling (3-day storm) | 20,178 m³ at real time and 20,181 m³ at 1000 yr/s (expected 20,178) |
| Flood surge (valley) | front travels from row 177 to the outlet in about 1.4 h; peak depth 9 m; balance 4e-7 % |
| 5-year drought (Temperate) | cover 0.51 → 0.14, groundwater −57 % against the no-drought run; full recovery 15 years later |

- **Self-test** (`selftest-results.json`): cone 1000 years, balance 5e-7 %, no NaN, 5.8 s.
  Bench at 60 fps at 256, 512 and 1024. Sub-steps/s: 56k at 256², 10.8k at 512² (was 11.7k),
  1.8k at 1024² (was 2.2k).
- **Everything on at 512²** (`tests/perf.js`): trees, fire, smoke and a storm cloud at 1 day/s
  and at 1000 yr/s. Steady 60 fps, with sim 4.3 ms + render 2.2 ms of GPU time and the governor
  at its 128 sub-step cap.
- **Screenshots** in `tests/`:
  - `shot-plants-colorado-summer.png` and `shot-plants-colorado-autumn.png` (gold aspens)
  - `shot-plants-pnw.png` and `shot-plants-utah.png`
  - `shot-fire-burning.png` and `shot-burn-scar-1yr.png`
  - `shot-storm-brush.png`, `shot-drought.png`, `shot-flood.png` (slow motion)
  - `shot-overlay-plants.png` and `shot-brush-cursor.png`
  - Re-make any of them with `sh tests/shoot.sh <name> '<window.__ settings>'`; see `tests/visual-plants.js`.

### Known limitations of round 2
- Fire spread is animated in "visual time" (one step per batch), not physical time. Its effects
  are in simulated time.
- At 1000 yr/s a burn scar heals within a frame or two, and a 5-year drought is a blip. That is
  physically right, and the messages say so and offer a better speed.
- Plant types (conifer, aspen, pinyon-juniper) are a rendering choice from climate and the
  preset's `forest` mix. The simulation tracks only total cover and woody share.
- The random terrain is very steep (median slope about 50°), so plants are allowed on thin soil
  in rock cracks. Without that, half of every map would be bare.
- At 1024², trees cost render time, so the governor gives the solver fewer hydraulic sub-steps
  per frame (8 versus 18 in round 1).
- Slow motion (below 1 day/s) caps the hydraulic sub-steps so water never runs faster than the clock.

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
`setSpeed(daysPerSec)`, `pause()`, `play()`, `stats()`, `bench(sizes?)`, `brush(type, opts)` (round 2, see above). Also `sim.engine` (the
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
- Glaciers accumulate but do not flow.
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
