# Neutral review harness

Used to compare competing builds the same way. It serves a build's `dist/` over http://127.0.0.1,
runs fixed scenarios on the high-performance GPU, and saves `results.json` plus screenshots.

    <electron.exe> tools/review --name=NAME --dist=<path to dist> --out=<output dir>
        [--overlayOnly]                        only the 10,000-year temperate run with the change map
        [--eval=probe.js [--shot=file.png]]    run one script in the page and save its result

The `*.js` files here are the probe scripts used in the round-1 review and verification
(north/south snow, groundwater pattern, storm statistics, UI click-through).
